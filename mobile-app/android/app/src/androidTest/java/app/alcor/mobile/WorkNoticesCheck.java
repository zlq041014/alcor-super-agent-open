package app.alcor.mobile;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import app.alcor.mobile.core.db.Database;
import app.alcor.mobile.feature.work.WorkNotices;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Opt-in because it exercises Android's actual notification channel on an isolated test device. */
final class WorkNoticesCheck {
    static String run(Context context) throws Exception {
        if (!android.os.Build.MODEL.startsWith("sdk_gphone")) throw new IllegalStateException("使用隔离 Android 模拟器验证通知");
        String id = UUID.randomUUID().toString(), name = "work-notices-check-" + id;
        var manager = context.getSystemService(NotificationManager.class);
        try (var database = new Database(context, name)) {
            var notices = new WorkNotices(context, database);
            if (!notices.enabled()) throw new IllegalStateException("测试前请允许系统通知");
            String[] stages = {"question", "review", "failed", "done"};
            String[] titles = {"有待回答的问题", "结果待验收", "执行失败", "工作已完成"};
            for (int i = 0; i < stages.length; i++) {
                JSONArray snapshot = snapshot(id, i + 1, stages[i]);
                expect(notices.reconcile(snapshot, true) == 1, "新状态未发出通知");
                Notification notice = posted(manager, id);
                expect(titles[i].contentEquals(notice.extras.getCharSequence(Notification.EXTRA_TITLE)), "通知标题不符");
                expect("样本电脑 · 样本项目".contentEquals(notice.extras.getCharSequence(Notification.EXTRA_TEXT)), "正文含未授权字段");
                expect(notice.contentIntent != null && notice.visibility == Notification.VISIBILITY_PRIVATE && notice.publicVersion != null,
                    "缺少打开动作或锁屏隐藏");
                expect(notices.reconcile(snapshot, true) == 0, "重复事件再次发出通知");
                notices.reconcile(new JSONArray(), true);
                expect(new WorkNotices(context, database).reconcile(snapshot, true) == 0, "重开后再次发出已处理通知");
            }
            JSONArray disabled = snapshot(id, 5, "failed");
            expect(notices.reconcile(disabled, false) == 0, "关闭后仍发通知");
            expect(notices.reconcile(disabled, true) == 0, "重新开启时补发旧通知");
            return "native four types, private lockscreen, replay and reopen deduplication, mode-off suppression";
        } finally {
            manager.cancel("alcor-work:" + id, 0);
            context.deleteDatabase(name);
        }
    }
    private static JSONArray snapshot(String id, int seq, String type) throws Exception {
        return new JSONArray().put(new JSONObject().put("id", id).put("seq", seq).put("type", type)
            .put("computer", "样本电脑").put("project", "样本项目").put("goal", "不要显示的任务正文"));
    }
    private static Notification posted(NotificationManager manager, String id) throws InterruptedException {
        for (int n = 0; n < 60; n++) {
            for (var item : manager.getActiveNotifications()) if (("alcor-work:" + id).equals(item.getTag()))
                return item.getNotification();
            Thread.sleep(20);
        }
        throw new AssertionError("Android 未登记工作通知");
    }
    private static void expect(boolean result, String message) { if (!result) throw new AssertionError(message); }
}
