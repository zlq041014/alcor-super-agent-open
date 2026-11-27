package app.alcor.mobile.bridge;

import android.webkit.JavascriptInterface;
import app.alcor.mobile.MobileService;
import app.alcor.mobile.core.Mode;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONObject;

/** The only object exposed to the WebView. Business work stays behind the host. */
public final class NativeBridge {
    private static final String LOCKED = "星引已锁定，请先解锁";
    private final Host host;
    private final MobileService service;
    private final ExecutorService io;

    public NativeBridge(Host host, MobileService service, ExecutorService io) {
        this.host = host;
        this.service = service;
        this.io = io;
    }

    @JavascriptInterface public String state() {
        return host.locked() ? "!" + LOCKED : host.loadState();
    }

    @JavascriptInterface public String commit(String json) {
        if (host.locked()) return LOCKED;
        if (json == null || json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 8 * 1024 * 1024)
            return "手机记录超过大小上限";
        return host.commitState(json);
    }

    @JavascriptInterface public String read() {
        return host.locked() ? "!" + LOCKED : host.readState();
    }

    @JavascriptInterface public String save(String json) {
        return host.locked() ? LOCKED : host.saveState(json);
    }

    @JavascriptInterface public boolean online() {
        return host.online();
    }

    @JavascriptInterface public void request(String id, String op, String payload) {
        boolean png = "image.export".equals(op);
        boolean exporting = png || "text.export".equals(op);
        if (id == null || payload == null || id.length() > 80 || payload.length() > (png ? 2800000 : exporting ? 950000 : 250000)) {
            host.result(id, "error", "请求超过大小上限");
            return;
        }
        if (host.locked()) { host.result(id, "error", LOCKED); return; }
        try {
            if (op.startsWith("privacy.")) {
                host.privacy(id, op, new JSONObject(payload));
                return;
            }
            if (exporting) {
                host.export(id, new JSONObject(payload), png);
                return;
            }
            io.execute(() -> {
                try {
                    if (host.locked()) { host.result(id, "error", LOCKED); return; }
                    JSONObject input = new JSONObject(payload);
                    if ("material.pick".equals(op)) {
                        host.pick(input.getString("dialog"), input.getBoolean("photos"));
                        host.result(id, "done", true);
                    } else if ("material.preview".equals(op)) {
                        host.result(id, "done", host.preview(input.getString("dialog"), input.getString("ref")));
                    } else if ("note.capture".equals(op)) {
                        host.capture(input.optString("source", "app"), Mode.parse(input.getString("mode")));
                        host.result(id, "done", true);
                    } else if ("note.preview".equals(op)) {
                        host.notePreview(Mode.parse(input.getString("mode")), input.getString("id"));
                        host.result(id, "done", true);
                    } else if ("reminders.permission".equals(op)) {
                        host.reminderPermission(input.getString("setting"));
                        host.result(id, "done", true);
                    } else if ("reminders.opened".equals(op)) {
                        host.result(id, "done", host.openedReminder());
                    } else if ("workNotice.opened".equals(op)) {
                        host.result(id, "done", host.openedWorkNotice());
                    } else if ("workNotice.settings".equals(op)) {
                        host.workNoticeSettings();
                        host.result(id, "done", true);
                    } else {
                        Object value = service.execute(op, input, text -> host.result(id, "delta", text));
                        host.result(id, "done", value);
                        if (op.startsWith("notes.") && !"notes.list".equals(op) && !"notes.get".equals(op))
                            host.event("notes.changed", new org.json.JSONObject());
                    }
                } catch (Exception error) {
                    host.result(id, "error", MobileService.issue(error));
                }
            });
        } catch (RejectedExecutionException error) {
            host.result(id, "error", "星引正在退出");
        } catch (Exception error) {
            host.result(id, "error", MobileService.issue(error));
        }
    }

    @JavascriptInterface public void copy(String text) {
        if (host.locked()) throw new IllegalStateException(LOCKED);
        host.copy(text);
    }

    @JavascriptInterface public void browse(String value) {
        if (host.locked()) throw new IllegalStateException(LOCKED);
        host.browse(value);
    }
}
