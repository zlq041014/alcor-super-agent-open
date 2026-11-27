package app.alcor.mobile;

import static app.alcor.mobile.DiscussionFiles.id;
import static app.alcor.mobile.DiscussionFiles.store;

import android.app.Activity;
import com.tencent.mm.opensdk.modelbiz.WXLaunchMiniProgram;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;
import com.tencent.mm.opensdk.utils.ILog;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

final class WechatImport {
    private final Activity activity;
    private final SecretStore secrets;
    private final String origin, appId, miniId;
    private final DiscussionFiles materials;
    private static final int MAX = 4 * 1024 * 1024;
    // OpenSDK diagnostics may include a launch path carrying the temporary upload ticket.
    private static final ILog NO_TICKET_LOG = new ILog() {
        public void v(String t, String s) {} public void d(String t, String s) {}
        public void i(String t, String s) {} public void w(String t, String s) {} public void e(String t, String s) {}
    };

    WechatImport(Activity activity, SecretStore secrets, DiscussionFiles materials) {
        this.activity = activity;
        this.secrets = secrets;
        origin = activity.getString(R.string.wechat_import_origin);
        appId = activity.getString(R.string.wechat_app_id);
        miniId = activity.getString(R.string.wechat_mini_id);
        this.materials = materials;
    }
    JSONObject status() throws Exception {
        JSONObject key = secrets.read("import-key");
        return new JSONObject().put("configured", !origin.isEmpty() && !appId.isEmpty() && !miniId.isEmpty())
            .put("paired", origin.equals(key.optString("origin")) && key.has("key"))
            .put("pending", secrets.read("import-pending").has("id"));
    }
    void setKey(String key) throws Exception {
        if (!key.matches("[!-~]{32,128}")) throw new IllegalArgumentException("导入口令格式不正确");
        secrets.write("import-key", new JSONObject().put("origin", origin).put("key", key));
    }
    private static int check(HttpsURLConnection c) throws Exception {
        int code = c.getResponseCode();
        if (code != 200 && code != 201 && code != 410)
            throw new IllegalStateException("微信文件服务返回 HTTP " + code + (code == 401 ? "，请核对导入口令" : ""));
        return code;
    }
    private static String url(JSONObject job) throws Exception {
        return job.getString("origin") + "/v1/imports/" + id(job.getString("id"));
    }
    synchronized void start(String dialog) throws Exception {
        if (secrets.read("import-pending").has("id")) throw new IllegalStateException("请先领取或取消上一次导入");
        if (!status().getBoolean("paired") || !status().getBoolean("configured")) throw new IllegalStateException("微信导入尚未配置");
        var api = WXAPIFactory.createWXAPI(activity, appId, true);
        try {
            api.setLogImpl(NO_TICKET_LOG);
            if (!api.isWXAppInstalled()) throw new IllegalStateException("请先安装微信");
            api.registerApp(appId);
            var c = Network.bearer(origin + "/v1/imports", "POST", secrets.read("import-key").getString("key"));
            JSONObject job;
            try {
                if (check(c) != 201) throw new IllegalStateException("没有创建微信导入请求");
                job = Network.read(c.getInputStream(), 2048);
            } finally { c.disconnect(); }
            String ticket = id(job.getString("write"));
            job.remove("write");
            job.put("dialog", dialog).put("origin", origin);
            id(job.getString("id")); id(job.getString("read"));
            secrets.write("import-pending", job);
            WXLaunchMiniProgram.Req req = new WXLaunchMiniProgram.Req();
            req.userName = miniId;
            req.path = "pages/import/index?id=" + job.getString("id") + "&ticket=" + ticket;
            req.miniprogramType = activity.getResources().getInteger(R.integer.wechat_mini_type);
            if (!api.sendReq(req)) throw new IllegalStateException("微信未接受跳转，请取消本次导入后核对登记信息");
        } finally { api.detach(); }
    }
    synchronized JSONObject collect() throws Exception {
        JSONObject job = secrets.read("import-pending");
        if (!job.has("id")) return new JSONObject();
        String batch = job.getString("id");
        File dir = materials.directory(batch);
        if (new File(dir, "manifest").isFile()) return materials.manifest(dir);
        var c = Network.bearer(url(job), "GET", job.getString("read"));
        JSONArray files;
        try {
            if (check(c) == 410) {
                forget(batch);
                throw new IllegalStateException("微信导入已过期，请重新选择文件");
            }
            JSONObject info = Network.read(c.getInputStream(), 8192);
            if (!info.getBoolean("ready")) return new JSONObject().put("waiting", true);
            files = info.getJSONArray("files");
        } finally { c.disconnect(); }
        if (files.length() < 1 || files.length() > 3) throw new IllegalStateException("接收的文件数不正确");
        Files.createDirectories(dir.toPath());
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.getJSONObject(i);
            int size = f.getInt("size");
            if (size < 0 || size > MAX || f.getString("name").length() > 200) throw new IllegalStateException("微信文件信息不符合导入限制");
            var data = Network.bearer(url(job) + "/files/" + i, "GET", job.getString("read"));
            try {
                if (check(data) != 200) throw new IllegalStateException("文件已过期，请重新选择");
                try (InputStream in = data.getInputStream()) { store(new File(dir, Integer.toString(i)), in, size); }
            } finally { data.disconnect(); }
            f.put("ref", batch + ":" + i);
        }
        JSONObject saved = new JSONObject().put("id", batch).put("dialog", job.getString("dialog")).put("files", files);
        byte[] meta = saved.toString().getBytes(StandardCharsets.UTF_8);
        store(new File(dir, "manifest"), new java.io.ByteArrayInputStream(meta), meta.length);
        return saved;
    }
    private void forget(String batch) throws Exception {
        materials.discard(batch);
        secrets.write("import-pending", new JSONObject());
    }
    synchronized void acknowledge(String batch) throws Exception {
        JSONObject job = secrets.read("import-pending");
        if (!job.has("id") || !job.getString("id").equals(batch)) return;
        var c = Network.bearer(url(job), "DELETE", job.getString("read"));
        try { check(c); } finally { c.disconnect(); }
        secrets.write("import-pending", new JSONObject());
    }
    synchronized void cancel() throws Exception {
        JSONObject job = secrets.read("import-pending");
        if (!job.has("id")) return;
        String batch = job.getString("id");
        if (!new File(materials.directory(batch), "manifest").exists()) forget(batch);
        else secrets.write("import-pending", new JSONObject());
        var c = Network.bearer(url(job), "DELETE", job.getString("read"));
        try { check(c); }
        catch (java.io.IOException e) { throw new IllegalStateException("本机已取消导入；中转未确认清理，到期自动删除", e); }
        finally { c.disconnect(); }
    }
}
