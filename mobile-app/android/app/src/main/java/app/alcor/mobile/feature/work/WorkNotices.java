package app.alcor.mobile.feature.work;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import app.alcor.mobile.MainActivity;
import app.alcor.mobile.R;
import app.alcor.mobile.core.db.Database;
import java.util.HashSet;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** System delivery of already-committed work alerts. Reads never change the work receipt. */
public final class WorkNotices {
    public static final String OPEN = "app.alcor.mobile.OPEN_WORK";
    public static final String ID = "workId";
    private static final String CHANNEL = "work-notices", TAG = "alcor-work:";
    private static final Pattern REQUEST_ID = Pattern.compile("[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}");
    private final Context context;
    private final Database database;
    private final NotificationManager manager;

    public WorkNotices(Context context, Database database) {
        this.context = context; this.database = database;
        manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "工作事项", NotificationManager.IMPORTANCE_DEFAULT));
    }

    public static boolean valid(String id) { return id != null && REQUEST_ID.matcher(id).matches(); }
    public boolean enabled() {
        return manager.areNotificationsEnabled() && manager.getNotificationChannel(CHANNEL).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    public Intent settings() {
        Intent intent = new Intent(manager.areNotificationsEnabled() ? Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS : Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        if (manager.areNotificationsEnabled()) intent.putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL);
        return intent;
    }

    private record Alert(String id, long seq, String label, String computer, String project) {
        static Alert parse(JSONObject entry) throws JSONException {
            String id = entry.getString("id");
            long seq = entry.getLong("seq");
            String label = switch (entry.getString("type")) {
                case "question" -> "有待回答的问题";
                case "review" -> "结果待验收";
                case "failed" -> "执行失败";
                case "done" -> "工作已完成";
                default -> throw new IllegalArgumentException("工作通知类型无效");
            };
            if (!valid(id) || seq <= 0) throw new IllegalArgumentException("工作通知编号无效");
            return new Alert(id, seq, label, name(entry.getString("computer")), name(entry.getString("project")));
        }
        private static String name(String value) {
            String clean = value.replaceAll("[\\p{Cntrl}]", " ").trim();
            return clean.substring(0, Math.min(clean.length(), 80));
        }
    }

    public synchronized int reconcile(JSONArray desired, boolean optedIn) throws JSONException {
        if (desired.length() > 100) throw new IllegalArgumentException("待提交的工作通知过多");
        var alerts = new java.util.ArrayList<Alert>();
        var active = new HashSet<String>();
        for (int i = 0; i < desired.length(); i++) {
            Alert alert = Alert.parse(desired.getJSONObject(i));
            if (!active.add(TAG + alert.id)) throw new IllegalArgumentException("工作通知重复");
            alerts.add(alert);
        }
        boolean allowed = optedIn && enabled();
        for (var item : manager.getActiveNotifications()) {
            String tag = item.getTag();
            if (tag != null && tag.startsWith(TAG) && (!allowed || !active.contains(tag))) manager.cancel(tag, 0);
        }
        int posted = 0;
        for (Alert alert : alerts)
            if (claim(alert.id, alert.seq) && allowed && publish(alert)) posted++;
        return posted;
    }

    // Record delivery intent before asking Android. Crash or denial does not re-alert; unread state remains in chat.
    private boolean claim(String id, long seq) {
        var db = database.getWritableDatabase();
        try (var found = db.query("work_notice_delivery", new String[]{"seq"}, "id = ?", new String[]{id}, null, null, null)) {
            if (found.moveToFirst() && found.getLong(0) >= seq) return false;
        }
        var row = new ContentValues(); row.put("id", id); row.put("seq", seq);
        if (db.replaceOrThrow("work_notice_delivery", null, row) < 0)
            throw new IllegalStateException("无法登记工作通知");
        return true;
    }

    @SuppressLint("MissingPermission")
    private boolean publish(Alert alert) {
        if (!enabled()) return false;
        var intent = new Intent(context, MainActivity.class).setAction(OPEN)
            .setData(new Uri.Builder().scheme("alcor").authority("work").appendPath(alert.id).build())
            .putExtra(ID, alert.id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        var click = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE);
        String place = alert.computer.isEmpty() ? alert.project : alert.project.isEmpty() ? alert.computer : alert.computer + " · " + alert.project;
        Notification masked = new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.alcor_mono)
            .setContentTitle("星引工作通知").build();
        Notification notice = new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.alcor_mono)
            .setContentTitle(alert.label).setContentText(place).setPublicVersion(masked)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(click).setAutoCancel(true).build();
        try { manager.notify(TAG + alert.id, 0, notice); }
        catch (SecurityException error) { if (enabled()) throw error; return false; }
        return true;
    }
}
