package app.alcor.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Explicit alarms run in this receiver; system boot and permission grants rebuild the queue. */
public final class ReminderAlarm extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        var container = ((AlcorApp) context.getApplicationContext()).container();
        var pending = goAsync();
        container.receiver().execute(() -> {
            try { refresh(container); }
            finally { pending.finish(); }
        });
    }

    static void refresh(AppContainer container) {
        try { container.reminders().fireDue(); }
        catch (Exception error) {
            // Do not record reminder bodies or raw database exceptions in Android logs.
            Log.e("AlcorReminders", "提醒调度失败：" + error.getClass().getSimpleName());
        }
    }
}
