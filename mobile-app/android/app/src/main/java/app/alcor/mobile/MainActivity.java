package app.alcor.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.AtomicFile;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;
import app.alcor.mobile.bridge.Host;
import app.alcor.mobile.bridge.NativeBridge;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.core.web.AssetPaths;
import app.alcor.mobile.feature.reminders.Reminders;
import app.alcor.mobile.feature.security.AppLock;
import app.alcor.mobile.feature.work.WorkNotices;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity implements Host {
    private static final int PAIR_SCAN = 5923;
    private record ScanReply(String id, String type, Object value) {}
    private String scanRequest;
    private ScanReply scanReply;
    private static final String HOST = "appassets.androidplatform.net";
    private static final int STATE_LIMIT = 8 * 1024 * 1024;
    private static final Object STATE_LOCK = new Object();
    private static long stateRevision;
    private final AtomicReference<String[]> reminderLink = new AtomicReference<>();
    private AppContainer container;
    private NativeBridge bridge;
    private AtomicFile state;
    private long loadedRevision = -1;
    private String pickerDialog;
    private File savingMarkdown;
    private WebView web;
    private FrameLayout root;
    private AppLock appLock;
    private boolean webStarted;
    private BackupFlow backup;
    private final Object backupFence = new Object();
    private boolean mergingBackup, reloadAfterBackup, allowRestoredSnapshot;
    private JSONObject backupNotice;
    private final AtomicReference<String> workNoticeLink = new AtomicReference<>();

    @SuppressLint("SetJavaScriptEnabled") // Only bundled assets can load in this WebView.
    @Override public void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        container = ((AlcorApp) getApplication()).container();
        state = new AtomicFile(new File(getFilesDir(), "discussions.json"));
        pickerDialog = bundle == null ? null : bundle.getString("pickerDialog");
        savingMarkdown = bundle == null ? null : container.markdown().restore(bundle.getString("savingMarkdown"));
        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                var system = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                var ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(system.left, system.top, system.right, Math.max(system.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(root);
        appLock = new AppLock(this, root, this::showUnlocked);
        backup = new BackupFlow(this, container);
        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        appearance();
        var settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setTextZoom(Math.round(100 * getResources().getConfiguration().fontScale));
        bridge = new NativeBridge(this, new MobileService(container), container.io());
        web.addJavascriptInterface(bridge, "AlcorNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                String path = uri.getPath();
                if ("https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == -1 && AssetPaths.allows(path)) {
                    try { return new WebResourceResponse(AssetPaths.mime(path), "UTF-8", getAssets().open(path.substring(1))); }
                    catch (IOException missing) { return denied(404, "Not Found"); }
                }
                return denied(403, "Forbidden");
            }
        });
        if (bundle == null && (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) receive(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receive(intent);
    }

    private void receive(Intent intent) {
        if (Reminders.OPEN.equals(intent.getAction())) {
            String id = intent.getStringExtra(Reminders.ID);
            String mode = intent.getStringExtra("mode");
            if (mode == null) mode = Mode.WORK.key; // Notifications already posted by v5 were work records.
            if (Reminders.validId(id) && (Mode.LIFE.key.equals(mode) || Mode.WORK.key.equals(mode))) {
                reminderLink.set(new String[]{id, mode});
                runJs("window.alcorReminderOpened?.()");
            }
            return;
        }
        if (WorkNotices.OPEN.equals(intent.getAction())) {
            String id = intent.getStringExtra(WorkNotices.ID);
            if (WorkNotices.valid(id)) {
                workNoticeLink.set(id);
                runJs("window.alcorWorkNoticeOpened?.()");
            }
            return;
        }
        receive(intent, null);
    }

    @Override public JSONObject openedReminder() {
        String[] link = reminderLink.getAndSet(null);
        if (link == null) return null;
        try { return new JSONObject().put("id", link[0]).put("mode", link[1]); }
        catch (org.json.JSONException error) { throw new IllegalStateException("无法打开提醒详情", error); }
    }

    @Override public String openedWorkNotice() { return workNoticeLink.getAndSet(null); }

    @Override public void workNoticeSettings() {
        runOnUiThread(() -> {
            if (isDestroyed() || locked()) return;
            try { startActivity(container.workNotices().settings()); }
            catch (android.content.ActivityNotFoundException error) {
                runJs("window.alcorNotice?.('无法打开系统通知设置')");
            }
        });
    }

    @Override public void reminderPermission(String setting) {
        Intent intent;
        switch (setting) {
            case "notifications" -> intent = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
            case "exact" -> {
                if (Build.VERSION.SDK_INT < 31) throw new IllegalArgumentException("本机无需单独授权精确定时");
                intent = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                    Uri.fromParts("package", getPackageName(), null));
            }
            default -> throw new IllegalArgumentException("提醒权限无效");
        }
        runOnUiThread(() -> {
            try { startActivity(intent); }
            catch (android.content.ActivityNotFoundException error) {
                runJs("window.alcorNotice?.('无法打开系统权限设置')");
            }
        });
    }

    private void receive(Intent intent, String target) {
        if (forwardToNote(intent)) return;
        if (!IncomingFiles.accepts(intent)) return;
        Mode mode = target == null ? Mode.active(this) : Mode.ofDialog(target);
        container.receiver().execute(() -> {
            try {
                container.incoming().receive(intent, target == null ? "" : target, mode);
                runJs("window.alcorInbox?.()");
            } catch (Exception error) {
                String reason = MobileService.issue(error);
                runOnUiThread(() -> android.widget.Toast.makeText(getApplicationContext(), reason, android.widget.Toast.LENGTH_LONG).show());
            }
        });
    }

    @SuppressWarnings("deprecation")
    private boolean forwardToNote(Intent intent) {
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return false;
        Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        boolean media = stream instanceof Uri || (intent.getClipData() != null &&
            intent.getClipData().getItemCount() > 0 && intent.getClipData().getItemAt(0).getUri() != null);
        if (media) return false;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0)
            text = intent.getClipData().getItemAt(0).getText();
        if (text == null) return false;
        try { startActivity(new Intent(intent).setClass(this, NoteActivity.class)); }
        catch (android.content.ActivityNotFoundException error) {
            android.widget.Toast.makeText(getApplicationContext(), "无法打开记一笔", android.widget.Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("pickerDialog", pickerDialog);
        if (savingMarkdown != null) out.putString("savingMarkdown", savingMarkdown.getName());
    }

    @SuppressWarnings("deprecation")
    @Override public void pick(String dialog, boolean photos) {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            if (pickerDialog != null) return;
            Intent pick;
            if (photos && Build.VERSION.SDK_INT >= 33)
                pick = new Intent(android.provider.MediaStore.ACTION_PICK_IMAGES).setType("image/*")
                    .putExtra(android.provider.MediaStore.EXTRA_PICK_IMAGES_MAX, 3);
            else pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(photos ? "image/*" : "*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            pickerDialog = dialog;
            try { startActivityForResult(pick, 5911); }
            catch (android.content.ActivityNotFoundException e) {
                pickerDialog = null;
                runJs("window.alcorNotice?.('此手机没有可用的系统选择器')");
            }
        });
    }

    @Override @SuppressWarnings("deprecation")
    protected void onActivityResult(int code, int status, Intent result) {
        super.onActivityResult(code, status, result);
        if (appLock.onActivityResult(code, status)) return;
        if (code == PAIR_SCAN) { pairScanReturned(status, result); return; }
        if (backup.result(code, status, result)) return;
        if (code == 5912) {
            File pending = savingMarkdown;
            savingMarkdown = null;
            if (pending != null) {
                Uri uri = status == RESULT_OK && result != null ? result.getData() : null;
                container.receiver().execute(() -> {
                    try {
                        if (uri != null) {
                            container.markdown().save(pending, uri);
                            exportNotice(pending.getName().endsWith(".png") ? "PNG 已保存" : "Markdown 已保存");
                        } else if (status == RESULT_OK) exportNotice("系统没有返回保存位置");
                    } catch (Exception error) {
                        exportNotice("保存失败，请确认保存位置可写");
                    } finally {
                        removeExport(pending);
                    }
                });
            }
            return;
        }
        if (code != 5911) return;
        String dialog = pickerDialog;
        pickerDialog = null;
        if (status != RESULT_OK || result == null || dialog == null) return;
        result.setAction(result.getClipData() != null ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_VIEW);
        receive(result, dialog);
    }

    @SuppressWarnings("deprecation")
    @Override public void export(String id, JSONObject input, boolean png) throws Exception {
        String mode = input.getString("mode");
        if (!mode.equals("save") && !mode.equals("share")) throw new IllegalArgumentException("导出方式无效");
        String title = input.getString("title");
        String name = png ? MarkdownFiles.imageName(title) : MarkdownFiles.name(title);
        File file = png ? container.markdown().stagePng(input.getString("base64")) : container.markdown().stage(input.getString("text"));
        runOnUiThread(() -> {
            if (isDestroyed() || locked()) {
                removeExport(file);
                if (!isDestroyed()) sendResult(id, "error", "星引已锁定，请先解锁");
                return;
            }
            try {
                if (mode.equals("save")) {
                    if (savingMarkdown != null) throw new IllegalStateException("请先完成上一次保存");
                    startActivityForResult(MarkdownFiles.create(name), 5912);
                    savingMarkdown = file;
                } else startActivity(container.markdown().share(file, name));
                sendResult(id, "done", true);
            } catch (Exception error) {
                removeExport(file);
                sendResult(id, "error", error instanceof IllegalStateException ? error.getMessage() : "无法打开系统保存或分享面板");
            }
        });
    }

    private void removeExport(File file) {
        try { java.nio.file.Files.deleteIfExists(file.toPath()); }
        catch (IOException error) { exportNotice("手机临时导出副本未能清理"); }
    }

    private void exportNotice(String message) {
        runOnUiThread(() -> android.widget.Toast.makeText(getApplicationContext(), message, android.widget.Toast.LENGTH_SHORT).show());
    }

    private static WebResourceResponse denied(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, null, new ByteArrayInputStream(new byte[0]));
    }

    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        web.getSettings().setTextZoom(Math.round(100 * config.fontScale));
        appearance();
    }

    private void appearance() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int color = Color.parseColor(dark ? "#15161f" : "#f7f8fc");
        root.setBackgroundColor(color);
        web.setBackgroundColor(color);
        if (Build.VERSION.SDK_INT >= 30) {
            var controller = getWindow().getInsetsController();
            int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (controller != null) controller.setSystemBarsAppearance(dark ? 0 : flags, flags);
            getWindow().setNavigationBarContrastEnforced(false);
        } else {
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
            root.setSystemUiVisibility(dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        runJs("window.alcorTheme?.(" + dark + ")");
    }

    @Override protected void onResume() {
        super.onResume();
        container.receiver().execute(() -> ReminderAlarm.refresh(container));
        if (!appLock.locked()) showUnlocked();
    }

    private void showUnlocked() {
        deliverScanReply();
        if (reloadAfterBackup) {
            reloadAfterBackup = false;
            synchronized (backupFence) { allowRestoredSnapshot = true; }
            web.reload();
            return;
        }
        if (!webStarted) {
            webStarted = true;
            web.loadUrl("https://" + HOST + "/index.html");
        } else runJs("window.alcorForeground?.(); window.alcorReminderOpened?.(); window.alcorWorkNoticeOpened?.()");
    }

    @Override @SuppressWarnings("deprecation") public void pairScan(String id) {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            if (locked() || Mode.active(this) != Mode.WORK || scanRequest != null) {
                sendResult(id, "error", "请在解锁后的工作模式打开扫码");
                return;
            }
            var options = new com.journeyapps.barcodescanner.ScanOptions()
                .setCaptureActivity(PairScanActivity.class).setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                .setPrompt("扫描电脑上的星引配对二维码").setBeepEnabled(false).setBarcodeImageEnabled(false).setOrientationLocked(false);
            options.addExtra(com.google.zxing.client.android.Intents.Scan.SHOW_MISSING_CAMERA_PERMISSION_DIALOG, false);
            scanRequest = id;
            try { startActivityForResult(options.createScanIntent(this), PAIR_SCAN); }
            catch (android.content.ActivityNotFoundException failure) {
                scanRequest = null;
                sendResult(id, "error", "无法打开扫码，可以粘贴配对码");
            }
        });
    }

    private void pairScanReturned(int status, Intent data) {
        String id = scanRequest;
        scanRequest = null;
        if (id == null) return;
        if (data != null && data.getBooleanExtra(com.google.zxing.client.android.Intents.Scan.MISSING_CAMERA_PERMISSION, false)) {
            scanReply = new ScanReply(id, "error", "没有相机权限，可以粘贴配对码");
        } else if (status == RESULT_OK && data != null) {
            String content = data.getStringExtra(com.google.zxing.client.android.Intents.Scan.RESULT);
            try { scanReply = new ScanReply(id, "done", PairingCode.require(content == null ? "" : content)); }
            catch (IllegalArgumentException invalid) { scanReply = new ScanReply(id, "error", invalid.getMessage()); }
        } else scanReply = new ScanReply(id, "done", JSONObject.NULL);
        deliverScanReply();
    }

    private void deliverScanReply() {
        if (locked() || scanReply == null) return;
        var reply = scanReply;
        scanReply = null;
        sendResult(reply.id(), reply.type(), reply.value());
    }

    @Override protected void onStop() {
        appLock.onStop();
        super.onStop();
    }

    @SuppressLint("GestureBackNavigation") // Android 13+ uses the registered callback above.
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { back(); }

    private void back() {
        synchronized (backupFence) { if (mergingBackup) return; }
        if (appLock.locked()) { finishAfterTransition(); return; }
        web.evaluateJavascript("Boolean(window.alcorBack?.())", value -> {
            if (!"true".equals(value)) finishAfterTransition();
        });
    }

    @Override protected void onDestroy() {
        backup.dismiss();
        appLock.destroy();
        root.removeView(web);
        web.destroy();
        web = null;
        bridge = null;
        super.onDestroy();
    }

    private void runJs(String script) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(script, null);
        });
    }

    void sendResult(String id, String type, Object data) {
        JSONArray args = new JSONArray().put(id).put(type).put(data);
        runJs("window.alcorResult?.(..." + args + ")");
    }

    @Override public boolean locked() { return appLock.locked(); }

    @Override public void privacy(String id, String op, JSONObject input) throws Exception {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            try {
                if (appLock.locked()) throw new IllegalStateException("请先解锁星引");
                switch (op) {
                    case "privacy.status" -> sendResult(id, "done", privacyStatus());
                    case "privacy.lock.set" -> appLock.setEnabled(input.getBoolean("enabled"), error -> {
                        if (error != null) sendResult(id, "error", error);
                        else sendResult(id, "done", privacyStatus());
                    });
                    case "privacy.lock.now" -> {
                        appLock.lockNow();
                        sendResult(id, "done", true);
                    }
                    case "privacy.backup.export" -> backup.pick(id, true);
                    case "privacy.backup.preview" -> backup.pick(id, false);
                    case "privacy.backup.restore" -> backup.apply(id);
                    case "privacy.backup.dismiss" -> {
                        backup.dismiss();
                        sendResult(id, "done", true);
                    }
                    case "privacy.backup.notice" -> {
                        sendResult(id, "done", backupNotice == null ? JSONObject.NULL : backupNotice);
                        backupNotice = null;
                    }
                    default -> throw new IllegalArgumentException("未知的隐私操作");
                }
            } catch (Exception error) {
                sendResult(id, "error", MobileService.issue(error));
            }
        });
    }

    private JSONObject privacyStatus() {
        try { return new JSONObject().put("enabled", appLock.enabled()).put("available", appLock.canAuthenticate()); }
        catch (org.json.JSONException error) { throw new IllegalStateException("无法查询应用锁状态", error); }
    }

    void beginBackupRestore() {
        synchronized (backupFence) { mergingBackup = true; }
    }

    void endBackupRestore(JSONObject counts) {
        if (counts == null) {
            synchronized (backupFence) { mergingBackup = false; }
            return;
        }
        if (isDestroyed()) return;
        backupNotice = counts;
        reloadAfterBackup = true;
        if (!locked()) showUnlocked();
    }

    @Override public String loadState() {
        synchronized (backupFence) {
            if (mergingBackup && !allowRestoredSnapshot) return "!正在恢复备份";
            try {
                String state = container.chat().stateJson();
                if (allowRestoredSnapshot) { allowRestoredSnapshot = false; mergingBackup = false; }
                return state;
            } catch (app.alcor.mobile.feature.chat.ChatStore.ImportFailure failure) { return "~" + failure.getMessage(); }
            catch (Exception error) { return "!" + MobileService.issue(error); }
        }
    }

    @Override public String commitState(String json) {
        synchronized (backupFence) {
            if (mergingBackup) return "正在恢复备份，未写入";
            try { container.chat().commit(json); return ""; }
            catch (Exception error) { return MobileService.issue(error); }
        }
    }

    @Override public String readState() {
        synchronized (STATE_LOCK) {
            String json;
            try { json = new String(state.readFully(), StandardCharsets.UTF_8); }
            catch (FileNotFoundException missing) { json = ""; }
            catch (IOException error) { return "!无法读取手机讨论记录"; }
            loadedRevision = stateRevision;
            return json;
        }
    }

    @Override public String saveState(String json) {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > STATE_LIMIT) return "手机记录已达大小上限，请先清理不再使用的草稿和会话";
        synchronized (STATE_LOCK) {
            if (loadedRevision != stateRevision) return "手机记录已由另一页面更新，请重新打开星引";
            FileOutputStream output = null;
            try {
                output = state.startWrite();
                output.write(bytes);
                state.finishWrite(output);
                loadedRevision = ++stateRevision;
                return "";
            } catch (IOException error) {
                if (output != null) state.failWrite(output);
                return "无法保存手机记录";
            }
        }
    }

    @Override public boolean online() {
        var manager = getSystemService(ConnectivityManager.class);
        var capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    @Override public void result(String id, String type, Object data) {
        sendResult(id, type, data);
    }

    @Override public JSONObject preview(String dialog, String ref) throws Exception {
        if (isDestroyed()) throw new IllegalStateException("星引正在退出");
        return container.materials().preview(this, dialog, ref);
    }

    @Override public void capture(String source, Mode mode) {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            try { startActivity(NoteActivity.launch(this, source).putExtra("mode", mode.key)); }
            catch (android.content.ActivityNotFoundException error) {
                android.widget.Toast.makeText(getApplicationContext(), "无法打开记一笔", android.widget.Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override public void notePreview(Mode mode, String id) throws Exception {
        if (!container.notes().get(mode, id).getBoolean("image")) throw new IllegalArgumentException("这条笔记没有图片");
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            try { container.notes().preview(mode, this, id); }
            catch (Exception error) {
                android.widget.Toast.makeText(getApplicationContext(), MobileService.issue(error), android.widget.Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override public void event(String type, JSONObject data) {
        String payload = "{\"type\":" + JSONObject.quote(type) + ",\"data\":" +
            (data == null ? "{}" : data.toString()) + "}";
        runJs("window.alcorEvent?.(" + payload + ")");
    }

    @Override public void copy(String text) {
        runOnUiThread(() -> {
            if (!isDestroyed() && !locked()) getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("星引", text));
        });
    }

    @Override public void browse(String value) {
        Uri uri = Uri.parse(value);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) return;
        runOnUiThread(() -> {
            if (isDestroyed() || locked()) return;
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
            catch (android.content.ActivityNotFoundException error) { runJs("window.alcorNotice?.('没有可以打开链接的浏览器')"); }
        });
    }
}
