package app.alcor.mobile;

import android.os.SystemClock;
import java.util.HashMap;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Credentials released to an in-flight turn stay on the native side. */
final class ModelTurns {
    private static final long MAX_AGE = 15 * 60_000L;
    private static final int MAX_TURNS = 16;
    private static final long LIMIT_TTL = 60_000;
    static final class Turn {
        private final JSONObject model;
        private final String searchKey;
        private final long opened;
        private DiscussionFiles.PreparedFiles attachments;
        private boolean uploadFailed;
        Turn(JSONObject model, String searchKey, long opened) { this.model = model; this.searchKey = searchKey; this.opened = opened; }
        JSONObject model() { return model; }
        String searchKey() { return searchKey; }
        long opened() { return opened; }

        synchronized void attach(DiscussionFiles materials, String dialog, JSONArray refs, JSONArray messages,
                                 DiscussionFiles.CheckPacket beforeUpload,
                                 DiscussionFiles.DocumentUploader uploader) throws Exception {
            if (uploadFailed) throw new IllegalStateException("本轮附件上传未确认，请重新发起请求");
            if (attachments != null && !attachments.matches(dialog, refs))
                throw new IllegalStateException("不能在同一回合更换所选附件，请重新发送");
            if (attachments == null) attachments = materials.prepareFiles(model, dialog, refs, messages);
            attachments.apply(messages);
            try { attachments.upload(beforeUpload, uploader); }
            catch (Exception failure) { uploadFailed = true; throw failure; }
        }

        synchronized void checkAttachments() throws Exception { if (attachments != null) attachments.check(); }
        synchronized void checkSelection(boolean provided) {
            if (attachments != null && !provided) throw new IllegalStateException("本轮续包缺少所选附件，请重新发送");
        }
    }
    private final HashMap<String, Turn> active = new HashMap<>();

    synchronized String begin(JSONObject model, String searchKey) {
        if (!model.has("key")) throw new IllegalStateException("请先配置模型");
        long now = SystemClock.elapsedRealtime();
        active.values().removeIf(t -> now - t.opened() >= MAX_AGE);
        if (active.size() >= MAX_TURNS) throw new IllegalStateException("进行中的模型回合过多，请稍后重试");
        String id = UUID.randomUUID().toString();
        active.put(id, new Turn(model, searchKey, now));
        return id;
    }

    synchronized Turn require(String id) {
        Turn turn = active.get(id);
        if (turn == null || SystemClock.elapsedRealtime() - turn.opened() >= MAX_AGE) {
            active.remove(id);
            throw new IllegalStateException("本轮原模型连接已移除或失效，没有改发其他模型");
        }
        return turn;
    }

    synchronized void end(String id) { active.remove(id); }

    synchronized void clear() { active.clear(); }

    synchronized void replaceKey(String endpoint, String key) {
        active.values().removeIf(t -> endpoint.equals(t.model().optString("endpoint")) && !key.equals(t.model().optString("key")));
    }

    synchronized void replaceSearchKey(String key) {
        active.values().removeIf(t -> !Network.usesOfficialModel(t.model()) && !t.searchKey().isEmpty() && !key.equals(t.searchKey()));
    }
}
