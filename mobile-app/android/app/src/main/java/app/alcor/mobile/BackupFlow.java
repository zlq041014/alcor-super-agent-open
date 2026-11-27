package app.alcor.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import java.io.IOException;
import org.json.JSONObject;

/** Owns the system document picker and the single reviewed, app-private restore preview. */
final class BackupFlow {
    private static final int SAVE = 5921, PICK = 5922;
    private final MainActivity activity;
    private final AppContainer container;
    private LocalBackup.Preview preview;
    private String pickerId;
    private int pickerCode;
    private boolean running;

    BackupFlow(MainActivity activity, AppContainer container) {
        this.activity = activity; this.container = container;
    }

    @SuppressWarnings("deprecation")
    void pick(String id, boolean writing) {
        if (pickerId != null || running) throw new IllegalStateException("请先完成当前备份操作");
        dismiss();
        Intent intent = new Intent(writing ? Intent.ACTION_CREATE_DOCUMENT : Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE).setType(writing ? "application/zip" : "*/*");
        if (writing) intent.putExtra(Intent.EXTRA_TITLE, LocalBackup.NAME);
        pickerId = id; pickerCode = writing ? SAVE : PICK;
        try { activity.startActivityForResult(intent, pickerCode); }
        catch (android.content.ActivityNotFoundException error) {
            pickerId = null;
            throw new IllegalStateException("系统文件选择器不可用", error);
        }
    }

    boolean result(int code, int result, Intent data) {
        if (code != SAVE && code != PICK) return false;
        if (pickerId == null || pickerCode != code) return true;
        String id = pickerId;
        pickerId = null;
        Uri uri = result == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) { activity.sendResult(id, "done", JSONObject.NULL); return true; }
        if (!"content".equals(uri.getScheme())) {
            activity.sendResult(id, "error", "请选择系统提供的备份文件");
            return true;
        }
        running = true;
        container.io().execute(() -> {
            try {
                if (code == SAVE) {
                    JSONObject counts = container.backup().exportTo(uri);
                    activity.runOnUiThread(() -> done(id, counts));
                } else {
                    LocalBackup.Preview loaded = container.backup().prepare(uri);
                    JSONObject counts = loaded.counts();
                    activity.runOnUiThread(() -> {
                        if (activity.isDestroyed()) { cleanup(loaded); return; }
                        preview = loaded;
                        done(id, counts);
                    });
                }
            } catch (Exception error) { activity.runOnUiThread(() -> failed(id, code == SAVE ? "备份未能保存" : "无法读取这份星引备份", error)); }
        });
        return true;
    }

    void apply(String id) {
        if (running || preview == null) throw new IllegalStateException("请重新选择并核对备份");
        LocalBackup.Preview verified = preview;
        preview = null; running = true;
        activity.beginBackupRestore();
        container.io().execute(() -> {
            JSONObject counts;
            try { counts = container.backup().merge(verified); }
            catch (Exception error) {
                cleanup(verified);
                activity.runOnUiThread(() -> {
                    activity.endBackupRestore(null);
                    failed(id, "恢复失败，本机记录未更改", error);
                });
                return;
            }
            cleanup(verified);
            ReminderAlarm.refresh(container);
            activity.runOnUiThread(() -> {
                done(id, counts);
                activity.endBackupRestore(counts);
            });
        });
    }

    void dismiss() {
        LocalBackup.Preview before = preview;
        preview = null;
        if (before != null) container.io().execute(() -> cleanup(before));
    }
    private void done(String id, Object result) {
        running = false;
        if (!activity.isDestroyed()) activity.sendResult(id, "done", result);
    }
    private void failed(String id, String label, Exception error) {
        running = false;
        String reason = error instanceof IllegalArgumentException ? error.getMessage() : label + "，请检查文件和剩余空间";
        if (!activity.isDestroyed()) activity.sendResult(id, "error", reason);
    }
    private static void cleanup(LocalBackup.Preview loaded) {
        try { loaded.close(); }
        catch (IOException error) { android.util.Log.w("AlcorBackup", "备份临时副本未清理"); }
    }
}
