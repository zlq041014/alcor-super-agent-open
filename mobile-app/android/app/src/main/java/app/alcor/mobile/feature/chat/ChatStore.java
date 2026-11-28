package app.alcor.mobile.feature.chat;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.AtomicFile;
import app.alcor.mobile.core.db.Database;
import app.alcor.mobile.core.Mode;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native owner of conversation state. The legacy discussions.json is imported once with a byte
 * identical backup; the WebView then receives a snapshot and writes back whole-state commits.
 */
public final class ChatStore {
    private static final int LEGACY_LIMIT = 8 * 1024 * 1024;
    private static final String META_IMPORT = "chat.import";
    private static final String META_ROOT_EXTRA = "chat.root.extra";
    private static final Set<String> ROOT_KEYS = Set.of("dialogs", "projects", "peers", "work",
        "last", "lastDiscussion", "artifactCache");
    private final Database database;
    private final File legacy;

    public ChatStore(Database database, File legacy) {
        this.database = database;
        this.legacy = legacy;
    }

    /** Snapshot for the WebView. An empty result means the caller should create its initial state. */
    public synchronized String stateJson() throws Exception {
        try {
            if (!imported()) importLegacy();
        } catch (ImportFailure failure) {
            throw failure;
        } catch (Exception error) {
            throw new ImportFailure("聊天记录迁移失败，旧记录仍在：" + error.getMessage());
        }
        JSONObject root = snapshot();
        return empty(root) ? "" : root.toString();
    }

    public synchronized void commit(String json) throws Exception {
        if (json == null || json.isEmpty()) throw new IllegalArgumentException("手机记录为空，未写入本地库");
        Plan plan = Plan.parse(json, LEGACY_LIMIT);
        SQLiteDatabase db = database.getWritableDatabase();
        db.beginTransaction();
        try {
            clear(db);
            write(db, plan);
            verify(db, plan);
            if (!imported()) setMeta(db, META_IMPORT, new JSONObject().put("at", System.currentTimeMillis())
                .put("source", "commit").put("counts", plan.counts()).toString());
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized boolean imported() throws JSONException {
        return meta().has(META_IMPORT);
    }

    public synchronized JSONObject importReport() throws JSONException {
        String value = meta().optString(META_IMPORT, "");
        return value.isEmpty() ? null : new JSONObject(value);
    }

    public synchronized JSONObject counts() throws JSONException {
        JSONObject counts = new JSONObject();
        try (Cursor cursor = database.getReadableDatabase().rawQuery(
                "SELECT (SELECT COUNT(*) FROM dialogs), (SELECT COUNT(*) FROM messages), " +
                "(SELECT COUNT(*) FROM decisions), (SELECT COUNT(*) FROM work), (SELECT COUNT(*) FROM peers), " +
                "(SELECT COUNT(*) FROM projects), (SELECT COUNT(*) FROM artifacts)", null)) {
            cursor.moveToFirst();
            counts.put("dialogs", cursor.getLong(0)).put("messages", cursor.getLong(1))
                .put("decisions", cursor.getLong(2)).put("work", cursor.getLong(3))
                .put("peers", cursor.getLong(4)).put("projects", cursor.getLong(5)).put("artifacts", cursor.getLong(6));
        }
        return counts;
    }

    private void importLegacy() throws Exception {
        SQLiteDatabase db = database.getWritableDatabase();
        JSONObject meta = meta();
        if (meta.has(META_IMPORT)) return;
        if (!legacy.exists()) {
            markEmpty(db);
            return;
        }
        if (!legacy.isFile()) throw new ImportFailure("旧记录不是普通文件，未迁移");
        if (legacy.length() == 0) {
            markEmpty(db);
            return;
        }
        if (legacy.length() > LEGACY_LIMIT) throw new ImportFailure("旧记录超过大小上限，未迁移");
        byte[] bytes = Files.readAllBytes(legacy.toPath());
        String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        if (text.trim().isEmpty()) throw new ImportFailure("旧记录为空，未迁移");
        Plan plan;
        try {
            plan = Plan.parse(text, LEGACY_LIMIT);
        } catch (JSONException | IllegalArgumentException error) {
            throw new ImportFailure("旧记录无法解析，未迁移：" + error.getMessage());
        }
        File backup = writeBackup(bytes);
        try {
            db.beginTransaction();
            try {
                clear(db);
                write(db, plan);
                verify(db, plan);
                setMeta(db, META_IMPORT, new JSONObject().put("at", System.currentTimeMillis())
                    .put("source", "legacy").put("bytes", bytes.length).put("sha256", sha256(bytes))
                    .put("backup", backup.getName()).put("counts", plan.counts()).toString());
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        } catch (Exception error) {
            throw new ImportFailure("聊天记录迁移失败，旧记录仍保留在 discussions.json：" + error.getMessage());
        }
    }

    private static void markEmpty(SQLiteDatabase db) throws JSONException {
        db.beginTransaction();
        try {
            setMeta(db, META_IMPORT, new JSONObject().put("at", System.currentTimeMillis())
                .put("source", "empty").put("counts", new JSONObject()
                    .put("dialogs", 0).put("messages", 0).put("decisions", 0).put("work", 0)
                    .put("peers", 0).put("projects", 0).put("artifacts", 0)).toString());
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private File writeBackup(byte[] bytes) throws Exception {
        File dir = legacy.getParentFile();
        String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
        File backup = new File(dir, "discussions.bak." + stamp + ".json");
        AtomicFile target = new AtomicFile(backup);
        FileOutputStream output = target.startWrite();
        try {
            output.write(bytes);
            target.finishWrite(output);
        } catch (IOException error) {
            target.failWrite(output);
            throw new ImportFailure("无法备份旧聊天记录，未迁移");
        }
        byte[] written = Files.readAllBytes(backup.toPath());
        if (written.length != bytes.length || !MessageDigest.isEqual(sha256(bytes).getBytes(StandardCharsets.US_ASCII),
                sha256(written).getBytes(StandardCharsets.US_ASCII)))
            throw new ImportFailure("旧聊天记录备份校验不一致，未迁移");
        return backup;
    }

    private JSONObject snapshot() throws JSONException {
        JSONObject root = new JSONObject();
        JSONObject dialogs = new JSONObject();
        try (Cursor rows = database.getReadableDatabase().query("dialogs",
                new String[]{"id", "messages_present", "decisions_present", "data"},
                null, null, null, null, "position")) {
            while (rows.moveToNext()) {
                String id = rows.getString(0);
                JSONObject dialog = new JSONObject(rows.getString(3));
                JSONArray local = messages(id, "local");
                if (rows.getInt(1) != 0) dialog.put("messages", local);
                JSONArray remote = messages(id, "remote");
                if (dialog.has("history")) dialog.getJSONObject("history").put("messages", remote);
                JSONArray decisions = new JSONArray();
                try (Cursor found = database.getReadableDatabase().query("decisions", new String[]{"data"},
                        "dialog = ?", new String[]{id}, null, null, "position")) {
                    while (found.moveToNext()) decisions.put(new JSONObject(found.getString(0)));
                }
                if (rows.getInt(2) != 0) dialog.put("decisions", decisions);
                dialogs.put(id, dialog);
            }
        }
        root.put("dialogs", dialogs);
        root.put("peers", objects("peers", "id"));
        root.put("projects", objects("projects", "key"));
        root.put("work", objects("work", "id"));
        JSONArray artifacts = new JSONArray();
        try (Cursor rows = database.getReadableDatabase().query("artifacts", new String[]{"data"},
                null, null, null, null, "position")) {
            while (rows.moveToNext()) artifacts.put(new JSONObject(rows.getString(0)));
        }
        if (artifacts.length() > 0) root.put("artifactCache", artifacts);
        JSONObject meta = meta();
        if (meta.has("last")) root.put("last", meta.getString("last"));
        if (meta.has("lastDiscussion")) root.put("lastDiscussion", meta.getString("lastDiscussion"));
        if (meta.has(META_ROOT_EXTRA)) {
            JSONObject extra = new JSONObject(meta.getString(META_ROOT_EXTRA));
            for (Iterator<String> keys = extra.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (!root.has(key)) root.put(key, extra.get(key));
            }
        }
        return root;
    }

    private JSONObject objects(String table, String key) throws JSONException {
        JSONObject result = new JSONObject();
        try (Cursor rows = database.getReadableDatabase().query(table, new String[]{key, "data"},
                null, null, null, null, "position")) {
            while (rows.moveToNext()) result.put(rows.getString(0), new JSONObject(rows.getString(1)));
        }
        return result;
    }

    private JSONArray messages(String dialog, String origin) throws JSONException {
        JSONArray result = new JSONArray();
        try (Cursor rows = database.getReadableDatabase().query("messages", new String[]{"data"},
                "dialog = ? AND origin = ?", new String[]{dialog, origin}, null, null, "position")) {
            while (rows.moveToNext()) result.put(new JSONObject(rows.getString(0)));
        }
        return result;
    }

    private void clear(SQLiteDatabase db) {
        for (String table : new String[]{"messages", "decisions", "dialogs", "work", "peers", "projects", "artifacts"})
            db.delete(table, null, null);
        db.delete("meta", "key IN (?, ?, ?)", new String[]{"last", "lastDiscussion", META_ROOT_EXTRA});
    }

    private void write(SQLiteDatabase db, Plan plan) throws JSONException {
        for (PeerRow peer : plan.peers) {
            var values = new ContentValues();
            values.put("id", peer.id);
            values.put("position", peer.position);
            values.put("data", peer.data.toString());
            db.insertOrThrow("peers", null, values);
        }
        for (ProjectRow project : plan.projects) {
            var values = new ContentValues();
            values.put("key", project.key);
            values.put("position", project.position);
            values.put("peer", project.data.optString("peer"));
            values.put("id", project.data.optString("id"));
            values.put("name", project.data.optString("name"));
            values.put("data", project.data.toString());
            db.insertOrThrow("projects", null, values);
        }
        for (DialogRow dialog : plan.dialogs) {
            var values = new ContentValues();
            values.put("id", dialog.id);
            values.put("position", dialog.position);
            values.put("kind", dialog.data.optString("kind"));
            values.put("title", dialog.data.optString("title"));
            values.put("project", dialog.data.optString("project"));
            values.put("peer", dialog.data.optString("peer"));
            values.put("used", dialog.data.optLong("used"));
            values.put("messages_present", dialog.hasMessages ? 1 : 0);
            values.put("decisions_present", dialog.hasDecisions ? 1 : 0);
            values.put("data", dialog.data.toString());
            db.insertOrThrow("dialogs", null, values);
            for (MessageRow message : dialog.messages) insert(db, dialog.id, "local", message);
            for (MessageRow message : dialog.remote) insert(db, dialog.id, "remote", message);
            for (int i = 0; i < dialog.decisions.size(); i++) {
                var decision = new ContentValues();
                decision.put("dialog", dialog.id);
                decision.put("id", dialog.decisions.get(i).getString("id"));
                decision.put("position", i);
                decision.put("data", dialog.decisions.get(i).toString());
                db.insertOrThrow("decisions", null, decision);
            }
        }
        for (WorkRow work : plan.work) {
            var values = new ContentValues();
            values.put("id", work.id);
            values.put("position", work.position);
            values.put("dialog", work.data.optString("dialog"));
            values.put("project", work.data.optString("project"));
            values.put("stage", work.data.optString("stage"));
            values.put("peer", work.data.optString("peer"));
            values.put("data", work.data.toString());
            db.insertOrThrow("work", null, values);
        }
        for (ArtifactRow artifact : plan.artifacts) {
            var values = new ContentValues();
            values.put("key", artifact.key);
            values.put("position", artifact.position);
            values.put("data", artifact.data.toString());
            db.insertOrThrow("artifacts", null, values);
        }
        if (plan.hasLast) setMeta(db, "last", plan.last);
        else db.delete("meta", "key = ?", new String[]{"last"});
        if (plan.hasLastDiscussion) setMeta(db, "lastDiscussion", plan.lastDiscussion);
        else db.delete("meta", "key = ?", new String[]{"lastDiscussion"});
        if (plan.extra.length() > 0) setMeta(db, META_ROOT_EXTRA, plan.extra.toString());
    }

    private static void insert(SQLiteDatabase db, String dialog, String origin, MessageRow message) {
        var values = new ContentValues();
        values.put("dialog", dialog);
        values.put("origin", origin);
        values.put("id", message.id);
        values.put("position", message.position);
        values.put("role", message.data.optString("role"));
        values.put("text", message.data.optString("text"));
        values.put("at", message.data.optString("at"));
        values.put("kind", message.data.has("kind") ? message.data.optString("kind") : null);
        values.put("data", message.data.toString());
        db.insertOrThrow("messages", null, values);
    }

    private static void setMeta(SQLiteDatabase db, String key, String value) {
        var values = new ContentValues();
        values.put("key", key);
        values.put("value", value);
        db.insertWithOnConflict("meta", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private JSONObject meta() throws JSONException {
        JSONObject meta = new JSONObject();
        try (Cursor rows = database.getReadableDatabase().query("meta", new String[]{"key", "value"},
                null, null, null, null, "key")) {
            while (rows.moveToNext()) meta.put(rows.getString(0), rows.getString(1));
        }
        return meta;
    }

    private void verify(SQLiteDatabase db, Plan plan) throws JSONException {
        JSONObject actual = new JSONObject();
        try (Cursor cursor = db.rawQuery("SELECT (SELECT COUNT(*) FROM dialogs), (SELECT COUNT(*) FROM messages), " +
                "(SELECT COUNT(*) FROM decisions), (SELECT COUNT(*) FROM work), (SELECT COUNT(*) FROM peers), " +
                "(SELECT COUNT(*) FROM projects), (SELECT COUNT(*) FROM artifacts)", null)) {
            cursor.moveToFirst();
            actual.put("dialogs", cursor.getLong(0)).put("messages", cursor.getLong(1))
                .put("decisions", cursor.getLong(2)).put("work", cursor.getLong(3))
                .put("peers", cursor.getLong(4)).put("projects", cursor.getLong(5)).put("artifacts", cursor.getLong(6));
        }
        JSONObject expected = plan.counts();
        if (actual.getLong("dialogs") != expected.getLong("dialogs") ||
            actual.getLong("messages") != expected.getLong("messages") ||
            actual.getLong("decisions") != expected.getLong("decisions") ||
            actual.getLong("work") != expected.getLong("work") ||
            actual.getLong("peers") != expected.getLong("peers") ||
            actual.getLong("projects") != expected.getLong("projects") ||
            actual.getLong("artifacts") != expected.getLong("artifacts"))
            throw new IllegalStateException("导入核对不一致：应为 " + expected + "，实际 " + actual);
    }

    private static boolean empty(JSONObject root) {
        return root.optJSONObject("dialogs").length() == 0 && root.optJSONObject("peers").length() == 0 &&
            root.optJSONObject("projects").length() == 0 && root.optJSONObject("work").length() == 0 &&
            !root.has("artifactCache") && !root.has("last") && !root.has("lastDiscussion");
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder text = new StringBuilder(64);
        for (byte value : digest) text.append(String.format(Locale.US, "%02x", value));
        return text.toString();
    }

    /** The legacy file could not be migrated; the caller keeps using it for this session. */
    public static final class ImportFailure extends IllegalStateException {
        public ImportFailure(String message) {
            super(message);
        }
    }

    private static final class Plan {
        final List<PeerRow> peers = new ArrayList<>();
        final List<ProjectRow> projects = new ArrayList<>();
        final List<DialogRow> dialogs = new ArrayList<>();
        final List<WorkRow> work = new ArrayList<>();
        final List<ArtifactRow> artifacts = new ArrayList<>();
        String last = "";
        String lastDiscussion = "";
        boolean hasLast, hasLastDiscussion;
        JSONObject extra = new JSONObject();

        static Plan parse(String json, int limit) throws JSONException {
            if (json.getBytes(StandardCharsets.UTF_8).length > limit)
                throw new IllegalArgumentException("记录超过 8 MiB 上限");
            JSONObject root = new JSONObject(json);
            JSONArray resume = array(root, "projectResumeCache");
            if (resume != null && (resume.length() > 8 || resume.toString().getBytes(StandardCharsets.UTF_8).length > 256 * 1024))
                throw new IllegalArgumentException("项目接续缓存超过上限");
            Plan plan = new Plan();
            JSONObject peers = object(root, "peers");
            int position = 0;
            for (Iterator<String> keys = peers.keys(); keys.hasNext(); ) {
                String key = keys.next();
                JSONObject data = objectValue(peers, key, "记录");
                plan.peers.add(new PeerRow(key, position++, data));
            }
            JSONObject projects = object(root, "projects");
            position = 0;
            for (Iterator<String> keys = projects.keys(); keys.hasNext(); ) {
                String key = keys.next();
                plan.projects.add(new ProjectRow(key, position++, objectValue(projects, key, "项目")));
            }
            JSONObject dialogs = object(root, "dialogs");
            position = 0;
            for (Iterator<String> keys = dialogs.keys(); keys.hasNext(); ) {
                String id = keys.next();
                JSONObject raw = objectValue(dialogs, id, "会话");
                DialogRow dialog = new DialogRow(id, position++);
                if (Mode.ofDialog(id) == Mode.LIFE &&
                        (!raw.optString("peer").isEmpty() || !raw.optString("project").isEmpty() ||
                        raw.has("history") || raw.has("session") || raw.has("out") || raw.has("decisionOut")))
                    throw new IllegalArgumentException("生活对话不能包含电脑同步数据");
                JSONArray messages = array(raw, "messages");
                for (int i = 0; messages != null && i < messages.length(); i++)
                    dialog.messages.add(message(messages.getJSONObject(i), i, dialog.id, dialog.seen));
                JSONObject history = raw.optJSONObject("history");
                if (raw.has("history") && history == null) throw new IllegalArgumentException("会话 " + id + " 的同步正文无效");
                JSONArray remote = array(history, "messages");
                for (int i = 0; remote != null && i < remote.length(); i++)
                    dialog.remote.add(message(remote.getJSONObject(i), i, dialog.id, dialog.seen));
                JSONArray decisions = array(raw, "decisions");
                for (int i = 0; decisions != null && i < decisions.length(); i++) {
                    JSONObject decision = decisions.getJSONObject(i);
                    if (decision.optString("id").isEmpty())
                        throw new IllegalArgumentException("会话 " + id + " 的决定缺少编号");
                    dialog.decisions.add(decision);
                }
                JSONObject data = new JSONObject(raw.toString());
                data.remove("messages");
                data.remove("decisions");
                dialog.hasMessages = raw.has("messages");
                dialog.hasDecisions = raw.has("decisions");
                if (history != null) {
                    JSONObject trimmed = new JSONObject(history.toString());
                    trimmed.remove("messages");
                    data.put("history", trimmed);
                }
                dialog.data = data;
                plan.dialogs.add(dialog);
            }
            JSONObject work = object(root, "work");
            position = 0;
            for (Iterator<String> keys = work.keys(); keys.hasNext(); ) {
                String key = keys.next();
                plan.work.add(new WorkRow(key, position++, objectValue(work, key, "交接")));
            }
            JSONArray artifacts = array(root, "artifactCache");
            for (int i = 0; artifacts != null && i < artifacts.length(); i++) {
                JSONObject artifact = artifacts.getJSONObject(i);
                if (artifact.optString("key").isEmpty()) throw new IllegalArgumentException("缓存产物缺少编号");
                plan.artifacts.add(new ArtifactRow(artifact.getString("key"), i, artifact));
            }
            plan.hasLast = root.has("last");
            plan.hasLastDiscussion = root.has("lastDiscussion");
            plan.last = root.optString("last", "");
            plan.lastDiscussion = root.optString("lastDiscussion", "");
            for (Iterator<String> keys = root.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (!ROOT_KEYS.contains(key)) plan.extra.put(key, root.get(key));
            }
            return plan;
        }

        private static JSONObject object(JSONObject parent, String name) {
            if (parent == null) return new JSONObject();
            JSONObject value = parent.optJSONObject(name);
            if (parent.has(name) && value == null) throw new IllegalArgumentException(name + " 不是有效对象");
            return value == null ? new JSONObject() : value;
        }

        private static JSONObject objectValue(JSONObject parent, String key, String label) {
            JSONObject value = parent.optJSONObject(key);
            if (value == null) throw new IllegalArgumentException(label + " " + key + " 不是有效对象");
            return value;
        }

        private static JSONArray array(JSONObject parent, String name) {
            if (parent == null || !parent.has(name)) return null;
            JSONArray value = parent.optJSONArray(name);
            if (value == null) throw new IllegalArgumentException(name + " 不是有效列表");
            return value;
        }

        private static MessageRow message(JSONObject raw, int position, String dialog, Set<String> seen) {
            String id = raw.optString("id");
            if (id.isEmpty()) throw new IllegalArgumentException("会话 " + dialog + " 的消息缺少编号");
            if (!seen.add(id)) throw new IllegalArgumentException("会话 " + dialog + " 有重复消息编号");
            return new MessageRow(id, position, raw);
        }

        JSONObject counts() throws JSONException {
            long messages = 0, decisions = 0;
            for (DialogRow dialog : dialogs) {
                messages += dialog.messages.size() + dialog.remote.size();
                decisions += dialog.decisions.size();
            }
            return new JSONObject().put("dialogs", dialogs.size()).put("messages", messages)
                .put("decisions", decisions).put("work", work.size()).put("peers", peers.size())
                .put("projects", projects.size()).put("artifacts", artifacts.size());
        }
    }

    private static final class PeerRow {
        final String id;
        final int position;
        final JSONObject data;

        PeerRow(String id, int position, JSONObject data) {
            this.id = id;
            this.position = position;
            this.data = data;
        }
    }

    private static final class ProjectRow {
        final String key;
        final int position;
        final JSONObject data;

        ProjectRow(String key, int position, JSONObject data) {
            this.key = key;
            this.position = position;
            this.data = data;
        }
    }

    private static final class DialogRow {
        final String id;
        final int position;
        final List<MessageRow> messages = new ArrayList<>();
        final List<MessageRow> remote = new ArrayList<>();
        final List<JSONObject> decisions = new ArrayList<>();
        final Set<String> seen = new HashSet<>();
        boolean hasMessages = true;
        boolean hasDecisions;
        JSONObject data;

        DialogRow(String id, int position) {
            this.id = id;
            this.position = position;
        }
    }

    private static final class MessageRow {
        final String id;
        final int position;
        final JSONObject data;

        MessageRow(String id, int position, JSONObject data) {
            this.id = id;
            this.position = position;
            this.data = data;
        }
    }

    private static final class WorkRow {
        final String id;
        final int position;
        final JSONObject data;

        WorkRow(String id, int position, JSONObject data) {
            this.id = id;
            this.position = position;
            this.data = data;
        }
    }

    private static final class ArtifactRow {
        final String key;
        final int position;
        final JSONObject data;

        ArtifactRow(String key, int position, JSONObject data) {
            this.key = key;
            this.position = position;
            this.data = data;
        }
    }
}
