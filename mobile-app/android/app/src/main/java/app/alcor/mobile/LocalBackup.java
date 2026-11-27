package app.alcor.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.core.db.Database;
import app.alcor.mobile.feature.chat.ChatStore;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Versioned business-data archive. There is deliberately no access to SecretStore. */
final class LocalBackup {
    static final String NAME = "星引备份.zip";
    private static final int DOCUMENT = 12 * 1024 * 1024, ITEM = 20 * 1024 * 1024, MEDIA = 192 * 1024 * 1024;
    private static final int MAX_MEDIA = 512;
    private static final String META = "alcor-backup.json";
    private static final String[] NOTES = {"id","mode","body","image","project","source","box","created","modified"};
    private static final String[] MEMORIES = {"id","mode","project","body","kind","source","source_ref","created","used","enabled","revised","deleted"};
    private static final String[] REMINDERS = {"id","mode","body","due","origin","origin_ref","version","state"};
    private final Context context;
    private final Database database;
    private final ChatStore chat;
    private final DiscussionFiles files;

    LocalBackup(Context context, Database database, ChatStore chat, DiscussionFiles files) {
        this.context = context; this.database = database; this.chat = chat; this.files = files;
    }

    static final class Preview implements AutoCloseable {
        private final File folder;
        private final JSONObject data;
        private Preview(File folder, JSONObject data) { this.folder = folder; this.data = data; }
        JSONObject counts() throws JSONException { return LocalBackup.counts(data); }
        @Override public void close() throws java.io.IOException { clear(folder); }
    }
    private record Media(File file, JSONObject entry) {}
    private record Export(JSONObject data, List<Media> media) {}

    private static JSONObject counts(JSONObject data) throws JSONException {
        JSONArray memories = data.getJSONArray("memories");
        int records = 0;
        for (int i = 0; i < memories.length(); i++)
            if (memories.getJSONObject(i).getInt("deleted") == 0) records++;
        return new JSONObject().put("dialogs", data.getJSONObject("dialogs").length())
            .put("notes", data.getJSONArray("notes").length()).put("memories", records)
            .put("deletedMemories", memories.length() - records)
            .put("reminders", data.getJSONArray("reminders").length()).put("files", data.getJSONArray("media").length());
    }

    JSONObject exportTo(Uri uri) throws Exception {
        try (var sink = context.getContentResolver().openOutputStream(uri, "wt")) {
            if (sink == null) throw new java.io.IOException("无法打开备份保存位置");
            return write(sink);
        }
    }

    JSONObject write(OutputStream sink) throws Exception {
        Export payload;
        synchronized (chat) {
            chat.stateJson(); // Complete any import before taking a read snapshot.
            var db = database.getWritableDatabase();
            db.beginTransactionNonExclusive();
            try { payload = snapshot(db); db.setTransactionSuccessful(); }
            finally { db.endTransaction(); }
        }
        byte[] manifest = payload.data.toString().getBytes(StandardCharsets.UTF_8);
        if (manifest.length > DOCUMENT) throw new IllegalArgumentException("备份记录超过 12 MiB");
        try (var zip = new ZipOutputStream(sink)) {
            zip.putNextEntry(new ZipEntry(META)); zip.write(manifest); zip.closeEntry();
            for (Media media : payload.media) {
                zip.putNextEntry(new ZipEntry("files/" + media.entry.getInt("slot")));
                try (var in = Files.newInputStream(media.file.toPath())) {
                    if (copy(in, zip, ITEM) != media.entry.getInt("size"))
                        throw new java.io.IOException("备份时附件发生变化，请重试");
                }
                zip.closeEntry();
            }
        }
        return counts(payload.data);
    }

    private Export snapshot(SQLiteDatabase db) throws Exception {
        JSONObject root = chatRoot(), dialogs = root.getJSONObject("dialogs"), result = new JSONObject();
        HashMap<String,String> ids = new HashMap<>();
        for (Iterator<String> keys = dialogs.keys(); keys.hasNext();) {
            String id = keys.next(); JSONObject d = dialogs.getJSONObject(id);
            String archived = d.optString("peer").isEmpty() ? id
                : "discussion:backup-" + UUID.nameUUIDFromBytes(id.getBytes(StandardCharsets.UTF_8));
            ids.put(id, archived);
        }
        var assets = new ArrayList<Media>();
        JSONArray media = new JSONArray();
        for (Iterator<String> keys = dialogs.keys(); keys.hasNext();) {
            String id = keys.next(); JSONObject d = dialogs.getJSONObject(id);
            String owner = ids.get(id);
            var safe = new JSONObject().put("id", owner).put("kind", isHome(owner) ? "home" : "discussion")
                .put("title", d.getString("title")).put("input", d.optString("input")).put("used", d.optLong("used"));
            JSONArray messages = new JSONArray(); var seen = new HashSet<String>();
            appendMessages(messages, seen, d.optJSONArray("messages"));
            JSONObject history = d.optJSONObject("history");
            if (history != null) appendMessages(messages, seen, history.optJSONArray("messages"));
            safe.put("messages", messages);
            JSONArray list = new JSONArray(), attached = d.optJSONArray("wxFiles");
            for (int i = 0; attached != null && i < attached.length(); i++) {
                var a = attached.getJSONObject(i);
                String ref = a.getString("ref");
                int slot = archiveFile(assets, media, id, ref);
                list.put(new JSONObject().put("slot", slot).put("key", a.optString("backupRef", ref)));
            }
            safe.put("files", list);
            result.put(owner, safe);
        }
        JSONArray notes = rows(db, "notes", NOTES), memories = rows(db, "memories", MEMORIES), reminders = rows(db, "reminders", REMINDERS);
        for (int i = 0; i < notes.length(); i++) {
            var row = notes.getJSONObject(i);
            if (!row.isNull("image"))
                row.put("media", archiveFile(assets, media, "note:" + row.getString("id"), row.getString("image")));
            row.remove("image");
        }
        for (int i = 0; i < memories.length(); i++) rewriteRef(memories.getJSONObject(i), "source_ref", ids);
        for (int i = 0; i < reminders.length(); i++) if ("chat".equals(reminders.getJSONObject(i).optString("origin")))
            rewriteRef(reminders.getJSONObject(i), "origin_ref", ids);
        JSONObject projects = new JSONObject(), sourceProjects = root.getJSONObject("projects");
        for (Iterator<String> keys = sourceProjects.keys(); keys.hasNext();) {
            String key = keys.next();
            projects.put(key, sourceProjects.getJSONObject(key).getString("name"));
        }
        JSONObject data = new JSONObject().put("version", 1).put("dialogs", result).put("projects", projects)
            .put("notes", notes).put("memories", memories).put("reminders", reminders).put("media", media);
        validate(data);
        return new Export(data, assets);
    }

    private JSONObject chatRoot() throws Exception {
        String state = chat.stateJson();
        return state.isEmpty() ? new JSONObject().put("dialogs", new JSONObject()).put("projects", new JSONObject())
            .put("peers", new JSONObject()).put("work", new JSONObject()) : new JSONObject(state);
    }
    private static boolean isHome(String id) { return "home".equals(id) || "home:life".equals(id); }
    private static void appendMessages(JSONArray dest, Set<String> seen, JSONArray source) throws JSONException {
        for (int i = 0; source != null && i < source.length(); i++) {
            JSONObject m = source.getJSONObject(i);
            String text = m.optString("text"), id = m.getString("id");
            if (text.isEmpty() || !seen.add(id)) continue;
            var row = new JSONObject().put("id", id).put("role", m.getString("role")).put("text", text).put("at", m.getString("at"));
            if (m.optBoolean("draft")) row.put("draft", true);
            if ("memory-command".equals(m.optString("kind"))) row.put("kind", "memory-command");
            dest.put(row);
        }
    }
    private int archiveFile(List<Media> all, JSONArray media, String owner, String ref) throws Exception {
        int index = all.size();
        File f = files.backupFile(owner, ref);
        if (!f.isFile()) throw new IllegalArgumentException("一份引用的附件已不存在，无法完整导出备份");
        JSONObject item = files.manifest(f.getParentFile()).getJSONArray("files").getJSONObject(Integer.parseInt(f.getName()));
        var safe = new JSONObject().put("slot", index).put("name", item.getString("name"))
            .put("mime", item.getString("mime")).put("size", f.length());
        media.put(safe); all.add(new Media(f, safe));
        return index;
    }
    private static void rewriteRef(JSONObject row, String field, HashMap<String,String> ids) throws JSONException {
        String value = row.optString(field);
        if (value.isEmpty()) return;
        JSONArray ref = new JSONArray(value);
        if (ref.length() != 2) throw bad();
        String old = ref.getString(0);
        row.put(field, new JSONArray().put(ids.getOrDefault(old, old)).put(ref.getString(1)).toString());
    }
    private static JSONArray rows(SQLiteDatabase db, String table, String[] columns) throws JSONException {
        JSONArray list = new JSONArray();
        try (Cursor cursor = db.query(table, columns, null, null, null, null, "id")) {
            while (cursor.moveToNext()) {
                JSONObject row = new JSONObject();
                for (int i = 0; i < columns.length; i++) {
                    Object value = switch (cursor.getType(i)) {
                        case Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(i);
                        case Cursor.FIELD_TYPE_NULL -> JSONObject.NULL;
                        default -> cursor.getString(i);
                    };
                    row.put(columns[i], value);
                }
                list.put(row);
            }
        }
        return list;
    }

    Preview prepare(Uri uri) throws Exception {
        File folder = Files.createTempDirectory(context.getCacheDir().toPath(), "alcor-restore-").toFile();
        try (var input = context.getContentResolver().openInputStream(uri)) {
            if (input == null) throw bad();
            return read(folder, input);
        } catch (Exception failure) {
            try { clear(folder); } catch (Exception cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }
    static Preview read(File folder, InputStream input) throws Exception {
        JSONObject data;
        long total = 0;
        Set<Integer> present = new HashSet<>();
        try (var zip = new ZipInputStream(input)) {
            ZipEntry first = zip.getNextEntry();
            if (first == null || !META.equals(first.getName())) throw bad();
            var bytes = new java.io.ByteArrayOutputStream();
            copy(zip, bytes, DOCUMENT);
            data = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            validate(data);
            JSONArray media = data.getJSONArray("media");
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (!entry.getName().matches("files/[0-9]{1,3}")) throw bad();
                int slot = Integer.parseInt(entry.getName().substring(6));
                if (slot >= media.length() || !present.add(slot) || entry.isDirectory()) throw bad();
                long size = media.getJSONObject(slot).getLong("size");
                try (var out = Files.newOutputStream(asset(folder, slot).toPath())) {
                    if (copy(zip, out, size) != size || (total += size) > MEDIA) throw bad();
                }
            }
            if (present.size() != media.length()) throw bad();
        }
        return new Preview(folder, data);
    }
    private static long copy(InputStream input, OutputStream output, long limit) throws java.io.IOException {
        var buf = new byte[32 * 1024];
        long count = 0;
        for (int n; (n = input.read(buf)) != -1;) {
            if ((count += n) > limit) throw new java.io.IOException("备份超过大小限制或附件长度不符");
            output.write(buf, 0, n);
        }
        return count;
    }
    private static File asset(File root, int slot) { return new File(root, "f" + slot); }
    private static void clear(File root) throws java.io.IOException {
        try (var items = Files.newDirectoryStream(root.toPath())) {
            for (var f : items) Files.delete(f);
        }
        Files.delete(root.toPath());
    }
    private static IllegalArgumentException bad() { return new IllegalArgumentException("备份内容无效或格式不受支持"); }

    private static void validate(JSONObject data) throws JSONException {
        if (data.getInt("version") != 1) throw bad();
        JSONArray media = data.getJSONArray("media");
        if (media.length() > MAX_MEDIA) throw bad();
        long size = 0;
        for (int i = 0; i < media.length(); i++) {
            JSONObject entry = media.getJSONObject(i);
            String name = entry.getString("name"), mime = entry.getString("mime");
            long bytes = entry.getLong("size");
            if (entry.getInt("slot") != i || name.isEmpty() || name.length() > 260 || name.matches("(?s).*[\\p{Cntrl}/\\\\].*") ||
                    !mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+") ||
                    bytes < 0 || bytes > ITEM || (size += bytes) > MEDIA) throw bad();
        }
        Set<Integer> referenced = new HashSet<>();
        JSONObject dialogs = data.getJSONObject("dialogs");
        for (Iterator<String> keys = dialogs.keys(); keys.hasNext();) {
            String id = keys.next(); var row = dialogs.getJSONObject(id);
            if (!isHome(id) && !id.matches("(life:)?discussion:[a-zA-Z0-9_-]{1,80}")) throw bad();
            if (!id.equals(row.getString("id")) || !(isHome(id) ? "home" : "discussion").equals(row.getString("kind")) ||
                    row.getString("title").length() > 512 || row.getString("input").length() > 14000) throw bad();
            JSONArray messages = row.getJSONArray("messages");
            var seen = new HashSet<String>();
            for (int i = 0; i < messages.length(); i++) {
                JSONObject m = messages.getJSONObject(i);
                if (!m.getString("role").matches("user|assistant|system") || m.getString("id").isEmpty() ||
                        !seen.add(m.getString("id")) || m.getString("at").isEmpty()) throw bad();
                m.getString("text");
            }
            JSONArray attached = row.getJSONArray("files"); var fileKeys = new HashSet<String>();
            for (int i = 0; i < attached.length(); i++) {
                JSONObject file = attached.getJSONObject(i);
                if (!file.getString("key").matches("[A-Za-z0-9_-]{32}:[0-2]") || !fileKeys.add(file.getString("key"))) throw bad();
                checkSlot(media, referenced, file.getInt("slot"));
            }
        }
        JSONObject projects = data.getJSONObject("projects");
        for (Iterator<String> it = projects.keys(); it.hasNext();) if (projects.getString(it.next()).length() > 512) throw bad();
        JSONArray notes = data.getJSONArray("notes"), memories = data.getJSONArray("memories"), reminders = data.getJSONArray("reminders");
        for (JSONArray rows : List.of(notes, memories, reminders)) {
            var ids = new HashSet<String>();
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                if (!ids.add(DiscussionFiles.id(row.getString("id")))) throw bad();
                Mode mode = Mode.parse(row.getString("mode"));
                String body = row.getString("body");
                if (rows == notes) {
                    if (body.length() > 16000 || !row.getString("box").matches("inbox|filed|archived") ||
                        !row.getString("source").matches("app|share|widget|shortcut|assistant")) throw bad();
                    if (row.has("media")) {
                        int slot = row.getInt("media"); checkSlot(media, referenced, slot);
                        if (!media.getJSONObject(slot).getString("mime").startsWith("image/")) throw bad();
                    } else if (body.trim().isEmpty()) throw bad();
                    row.getLong("created"); row.getLong("modified");
                } else if (rows == memories) {
                    if (body.length() > 1000 || !row.getString("kind").matches("explicit|candidate") ||
                        !row.getString("source").equals("chat")) throw bad();
                    int deleted = bit(row, "deleted"); bit(row, "enabled"); bit(row, "revised");
                    if (deleted == 0) {
                        if (body.trim().isEmpty()) throw bad();
                        checkChatRef(row.getString("source_ref"), mode);
                    }
                    row.getLong("created");
                    if (!row.isNull("used")) row.getLong("used");
                } else {
                    String origin = row.getString("origin"), originRef = row.getString("origin_ref");
                    if (body.trim().isEmpty() || body.length() > 200 || !origin.matches("chat|note|manual") ||
                        !row.getString("state").matches("scheduled|posted|blocked|cancelled") ||
                        row.getLong("due") < 0 || row.getInt("version") < 1) throw bad();
                    if ("chat".equals(origin)) checkChatRef(originRef, mode);
                    if ("note".equals(origin)) DiscussionFiles.id(originRef);
                }
                if (rows != reminders && (row.getString("project").length() > 512 ||
                    (mode == Mode.LIFE && !row.getString("project").isEmpty()))) throw bad();
            }
        }
        if (referenced.size() != media.length()) throw bad();
    }
    private static void checkChatRef(String value, Mode mode) throws JSONException {
        JSONArray ref = new JSONArray(value);
        if (ref.length() != 2 || Mode.ofDialog(ref.getString(0)) != mode || ref.getString(1).isEmpty()) throw bad();
    }
    private static int bit(JSONObject row, String field) throws JSONException {
        int value = row.getInt(field); if (value < 0 || value > 1) throw bad(); return value;
    }
    private static void checkSlot(JSONArray media, Set<Integer> references, int slot) {
        if (slot < 0 || slot >= media.length() || !references.add(slot)) throw bad();
    }

    JSONObject merge(Preview preview) throws Exception {
        var addedFiles = new ArrayList<String>();
        synchronized (chat) {
            JSONObject state = chatRoot();
            var db = database.getWritableDatabase();
            db.beginTransaction();
            boolean committed = false;
            try {
                int dialogs, notes, memories, reminders;
                try {
                    dialogs = mergeDialogs(state, preview, addedFiles);
                    notes = mergeNotes(db, preview, addedFiles);
                    memories = mergeMemories(db, preview.data.getJSONArray("memories"));
                    reminders = mergeReminders(db, preview.data.getJSONArray("reminders"));
                    chat.commit(state.toString());
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
                committed = true;
                return new JSONObject().put("dialogs", dialogs).put("notes", notes).put("memories", memories)
                    .put("reminders", reminders).put("files", addedFiles.size());
            } catch (Exception failure) {
                if (!committed) for (String batch : addedFiles) {
                    try { files.discard(batch); } catch (Exception cleanup) { failure.addSuppressed(cleanup); }
                }
                throw failure;
            }
        }
    }
    private int mergeDialogs(JSONObject state, Preview preview, List<String> added) throws Exception {
        var data = preview.data;
        JSONObject incoming = data.getJSONObject("dialogs"), current = state.getJSONObject("dialogs");
        JSONObject archiveProjects = data.getJSONObject("projects"), projects = state.getJSONObject("projects");
        for (Iterator<String> it = archiveProjects.keys(); it.hasNext();) {
            String key = it.next();
            if (!projects.has(key)) projects.put(key, new JSONObject().put("key", key).put("id", key)
                .put("name", archiveProjects.getString(key)).put("shared", false));
        }
        int count = 0;
        for (Iterator<String> it = incoming.keys(); it.hasNext();) {
            String id = it.next();
            JSONObject source = incoming.getJSONObject(id), dest = current.optJSONObject(id);
            if (dest == null) {
                dest = new JSONObject().put("id", id).put("kind", source.getString("kind"))
                    .put("title", source.getString("title")).put("input", source.getString("input"))
                    .put("used", source.getLong("used"));
                if (!isHome(id)) dest.put("own", true).put("listed", true);
                current.put(id, dest);
                count++;
            }
            if (!dest.optString("peer").isEmpty() || !dest.optString("project").isEmpty()) continue;
            JSONArray messages = dest.optJSONArray("messages");
            if (messages == null) { messages = new JSONArray(); dest.put("messages", messages); }
            if (isHome(id) && messages.length() == 0 && dest.optString("input").isEmpty())
                dest.put("input", source.getString("input"));
            var ids = new HashSet<String>();
            for (int i = 0; i < messages.length(); i++) ids.add(messages.getJSONObject(i).getString("id"));
            appendMessages(messages, ids, source.getJSONArray("messages"));
            JSONArray existing = dest.optJSONArray("wxFiles"), incomingFiles = source.getJSONArray("files");
            if (incomingFiles.length() == 0) continue;
            if (existing == null) { existing = new JSONArray(); dest.put("wxFiles", existing); }
            var fileKeys = new HashSet<String>();
            for (int i = 0; i < existing.length(); i++) {
                var info = existing.getJSONObject(i);
                fileKeys.add(info.optString("backupRef", info.getString("ref")));
            }
            for (int i = 0; i < incomingFiles.length(); i++) {
                var item = incomingFiles.getJSONObject(i);
                String key = item.getString("key");
                if (!fileKeys.add(key)) continue;
                String batch = Notes.newId();
                existing.put(restoreFile(preview, item.getInt("slot"), batch, id, added).put("backupRef", key));
            }
        }
        for (String id : List.of("home", "home:life")) if (!current.has(id))
            current.put(id, new JSONObject().put("id", id).put("kind", "home").put("title", "星引总管")
                .put("input", "").put("used", 0).put("messages", new JSONArray()));
        return count;
    }
    private JSONObject restoreFile(Preview preview, int slot, String batch, String owner, List<String> added) throws Exception {
        JSONObject file = preview.data.getJSONArray("media").getJSONObject(slot);
        JSONObject restored = files.restoreBackupFile(batch, owner, asset(preview.folder, slot),
            file.getString("name"), file.getString("mime"));
        added.add(batch);
        return restored;
    }
    private int mergeNotes(SQLiteDatabase db, Preview preview, List<String> added) throws Exception {
        JSONArray rows = preview.data.getJSONArray("notes");
        int count = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            String id = row.getString("id");
            if (exists(db, "notes", id)) continue;
            var values = values(row, NOTES);
            if (row.has("media"))
                values.put("image", restoreFile(preview, row.getInt("media"), id, "note:" + id, added).getString("ref"));
            db.insertOrThrow("notes", null, values);
            count++;
        }
        return count;
    }
    private static int mergeMemories(SQLiteDatabase db, JSONArray rows) throws JSONException {
        int count = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            if (row.getInt("deleted") != 1) continue;
            var tombstone = values(row, MEMORIES);
            tombstone.put("body", ""); tombstone.put("source_ref", ""); tombstone.put("project", "");
            tombstone.put("enabled", 0); tombstone.putNull("used");
            if (db.update("memories", tombstone, "id = ? AND mode = ?", new String[]{row.getString("id"), row.getString("mode")}) == 0)
                insertNew(db, "memories", tombstone);
        }
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            if (row.getInt("deleted") == 0 && insertNew(db, "memories", values(row, MEMORIES))) count++;
        }
        return count;
    }
    private static int mergeReminders(SQLiteDatabase db, JSONArray rows) throws JSONException {
        long now = System.currentTimeMillis();
        int count = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            var values = values(row, REMINDERS);
            if ("scheduled".equals(row.getString("state")) && row.getLong("due") <= now) values.put("state", "blocked");
            if (insertNew(db, "reminders", values)) count++;
        }
        return count;
    }
    private static boolean exists(SQLiteDatabase db, String table, String id) {
        try (var row = db.query(table, new String[]{"id"}, "id = ?", new String[]{id}, null, null, null)) {
            return row.moveToFirst();
        }
    }
    private static boolean insertNew(SQLiteDatabase db, String table, ContentValues row) {
        if (exists(db, table, row.getAsString("id"))) return false;
        db.insertOrThrow(table, null, row);
        return true;
    }
    private static ContentValues values(JSONObject row, String[] fields) throws JSONException {
        var values = new ContentValues();
        for (String field : fields) {
            if (row.isNull(field)) values.putNull(field);
            else if (row.get(field) instanceof Number) values.put(field, row.getLong(field));
            else values.put(field, row.getString(field));
        }
        return values;
    }
}
