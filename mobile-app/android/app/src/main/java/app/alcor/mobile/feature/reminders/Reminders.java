package app.alcor.mobile.feature.reminders;

import android.annotation.SuppressLint;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import app.alcor.mobile.MainActivity;
import app.alcor.mobile.R;
import app.alcor.mobile.ReminderAlarm;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.core.db.Database;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A single queue owns system alarms and the lifecycle of locally scheduled reminders. */
public final class Reminders {
    public static final String OPEN = "app.alcor.mobile.OPEN_REMINDER";
    public static final String ID = "reminderId";
    private static final String CHANNEL = "reminders";
    private static final String LIFE_CHANNEL = "life-reminders";
    private static final int PAGE = 30;
    private static final String[] FIELDS = {"id", "body", "due", "origin", "origin_ref", "version", "state", "mode"};
    private final Context context;
    private final Database database;
    private final AlarmManager alarms;
    private final NotificationManager notifications;

    public Reminders(Context context, Database database) {
        this.context = context;
        this.database = database;
        alarms = context.getSystemService(AlarmManager.class);
        notifications = context.getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, "提醒", NotificationManager.IMPORTANCE_HIGH));
        notifications.createNotificationChannel(new NotificationChannel(LIFE_CHANNEL, "生活提醒", NotificationManager.IMPORTANCE_HIGH));
    }

    public static boolean validId(String id) {
        return id != null && id.matches("[a-f0-9]{32}");
    }

    private static String[] key(String id) {
        if (!validId(id)) throw new IllegalArgumentException("提醒编号无效");
        return new String[]{id};
    }

    private boolean exact() {
        return Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms();
    }

    private static String channel(Mode mode) { return mode == Mode.LIFE ? LIFE_CHANNEL : CHANNEL; }

    private boolean canNotify(Mode mode) {
        return notifications.areNotificationsEnabled() &&
            notifications.getNotificationChannel(channel(mode)).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    public JSONObject permissions(Mode mode) throws JSONException {
        return new JSONObject().put("notifications", canNotify(mode)).put("exact", exact());
    }

    private static JSONObject row(Cursor cursor) throws JSONException {
        return new JSONObject().put("id", cursor.getString(0)).put("text", cursor.getString(1))
            .put("at", cursor.getLong(2)).put("origin", cursor.getString(3)).put("ref", cursor.getString(4))
            .put("version", cursor.getInt(5)).put("state", cursor.getString(6)).put("mode", cursor.getString(7));
    }

    private JSONObject find(String id) throws JSONException {
        try (var rows = database.getReadableDatabase().query("reminders", FIELDS, "id = ?", key(id), null, null, null)) {
            return rows.moveToFirst() ? row(rows) : null;
        }
    }

    public JSONObject get(Mode mode, String id, boolean opened) throws JSONException {
        JSONObject reminder = find(id);
        if (reminder == null || !mode.key.equals(reminder.getString("mode"))) throw new IllegalArgumentException("这条提醒已不存在");
        if (opened) notifications.cancel(id, 0);
        return reminder;
    }

    public JSONObject list(Mode mode, boolean history, int offset) throws JSONException {
        if (offset < 0 || offset % PAGE != 0) throw new IllegalArgumentException("提醒分页无效");
        var reminders = new JSONArray();
        boolean more;
        try (var rows = database.getReadableDatabase().query("reminders", FIELDS,
                "mode = ? AND " + (history ? "state != 'scheduled'" : "state = 'scheduled'"), new String[]{mode.key}, null, null,
                history ? "due DESC, id DESC" : "due, id", offset + "," + (PAGE + 1))) {
            while (reminders.length() < PAGE && rows.moveToNext()) reminders.put(row(rows));
            more = rows.moveToNext();
        }
        return new JSONObject().put("items", reminders).put("more", more).put("permissions", permissions(mode));
    }

    private static ContentValues input(String text, long at) {
        var data = new ContentValues();
        text = text.trim();
        if (text.isEmpty() || text.length() > 200) throw new IllegalArgumentException("提醒内容需要 1 至 200 字");
        if (at <= System.currentTimeMillis() || at > 253402300799999L)
            throw new IllegalArgumentException("请选择未来的提醒时间");
        data.put("body", text);
        data.put("due", at);
        return data;
    }

    public synchronized JSONObject add(Mode mode, String id, String text, long at, String origin, String ref) throws JSONException {
        JSONObject existing = find(id);
        if (existing == null) {
            var values = input(text, at);
            if (!origin.matches("manual|note|chat") || ref.length() > 240)
                throw new IllegalArgumentException("提醒来源无效");
            values.put("id", id);
            values.put("mode", mode.key);
            values.put("origin", origin);
            values.put("origin_ref", ref);
            database.getWritableDatabase().insertOrThrow("reminders", null, values);
        } else if (!mode.key.equals(existing.getString("mode"))) throw new IllegalStateException("提醒编号已在另一模式使用");
        rearm();
        return get(mode, id, false).put("permissions", permissions(mode));
    }

    public synchronized JSONObject edit(Mode mode, String id, int version, String text, long at) throws JSONException {
        change(mode, id, version, input(text, at));
        return get(mode, id, false);
    }

    public synchronized JSONObject cancel(Mode mode, String id, int version) throws JSONException {
        JSONObject current = get(mode, id, false);
        // The same cancellation can be acknowledged after the UI loses its reply.
        if ("cancelled".equals(current.getString("state")) && current.getInt("version") == version + 1) {
            rearm();
            return current;
        }
        var values = new ContentValues();
        values.put("state", "cancelled");
        change(mode, id, version, values);
        notifications.cancel(id, 0);
        return get(mode, id, false);
    }

    private void change(Mode mode, String id, int version, ContentValues values) {
        key(id);
        values.put("version", version + 1);
        int n = database.getWritableDatabase().update("reminders", values,
            "id = ? AND mode = ? AND version = ? AND state = 'scheduled'", new String[]{id, mode.key, Integer.toString(version)});
        if (n != 1) throw new IllegalStateException("这条提醒已变化，请重新打开");
        rearm();
    }

    private PendingIntent alarm(int channel) {
        return PendingIntent.getBroadcast(context, channel, new Intent(context, ReminderAlarm.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @SuppressLint("ScheduleExactAlarm")
    public synchronized void rearm() {
        long earliest;
        try (var rows = database.getReadableDatabase().rawQuery(
                "SELECT due FROM reminders WHERE state = 'scheduled' ORDER BY due LIMIT 1", null)) {
            earliest = rows.moveToFirst() ? rows.getLong(0) : 0;
        }
        var approximate = alarm(0);
        var precise = alarm(1);
        if (earliest == 0) {
            alarms.cancel(approximate);
            alarms.cancel(precise);
            return;
        }
        long when = Math.max(earliest, System.currentTimeMillis() + 250);
        // Revoking exact permission removes exact alarms. Leave a separate approximate alarm scheduled.
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, approximate);
        if (exact()) {
            try { alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, precise); }
            catch (SecurityException revoked) {
                if (exact()) throw revoked;
                alarms.cancel(precise);
            }
        } else alarms.cancel(precise);
    }

    public synchronized void fireDue() throws JSONException {
        var due = new JSONArray();
        try (var rows = database.getReadableDatabase().query("reminders", FIELDS, "state = 'scheduled' AND due <= ?",
                new String[]{Long.toString(System.currentTimeMillis())}, null, null, "due, id", Integer.toString(PAGE))) {
            while (rows.moveToNext()) due.put(row(rows));
        }
        for (int i = 0; i < due.length(); i++) {
            var reminder = due.getJSONObject(i);
            String id = reminder.getString("id");
            var values = new ContentValues();
            values.put("state", publish(id, reminder.getString("mode"), reminder.getString("text")) ? "posted" : "blocked");
            database.getWritableDatabase().update("reminders", values, "id = ?", key(id));
        }
        rearm();
    }

    @SuppressLint("MissingPermission")
    private boolean publish(String id, String storedMode, String text) {
        Mode mode = Mode.parse(storedMode);
        if (!canNotify(mode)) return false;
        String channel = channel(mode);
        var intent = new Intent(context, MainActivity.class).setAction(OPEN)
            .setData(new Uri.Builder().scheme("alcor").authority("reminder").appendPath(id).build())
            .putExtra(ID, id).putExtra("mode", mode.key).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        var click = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE);
        var publicVersion = new Notification.Builder(context, channel).setSmallIcon(R.drawable.alcor_mono)
            .setContentTitle("星引提醒").build();
        var notice = new Notification.Builder(context, channel).setSmallIcon(R.drawable.alcor_mono)
            .setContentTitle("提醒").setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion)
            .setContentIntent(click).setAutoCancel(true).setOnlyAlertOnce(true).build();
        try { notifications.notify(id, 0, notice); }
        catch (SecurityException revoked) {
            if (canNotify(mode)) throw revoked;
            return false;
        }
        return true;
    }
}
