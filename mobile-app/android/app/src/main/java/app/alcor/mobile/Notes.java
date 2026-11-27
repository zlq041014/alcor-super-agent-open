package app.alcor.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.core.db.Database;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Local notes. Saving only touches SQLite and private files; it never calls the network or a model. */
final class Notes {
    static final int TEXT_LIMIT = 16000;
    static final String INBOX = "inbox", FILED = "filed", ARCHIVED = "archived";
    private static final String[] FIELDS = {"id", "body", "image", "project", "source", "box", "created", "modified"};
    private final Database db;
    private final Context context;
    private final DiscussionFiles files;

    Notes(Context context, Database db, DiscussionFiles files) {
        this.context = context.getApplicationContext();
        this.db = db;
        this.files = files;
    }

    static String newId() { return UUID.randomUUID().toString().replace("-", ""); }
    private static String owner(String id) { return "note:" + DiscussionFiles.id(id); }

    private static void validate(String text, boolean hasImage) {
        if (text.length() > TEXT_LIMIT) throw new IllegalArgumentException("原文不能超过 16,000 字，请分开记");
        if (text.trim().isEmpty() && !hasImage) throw new IllegalArgumentException("写点什么，或选一张图片");
    }

    private static String box(String value) {
        if (!INBOX.equals(value) && !FILED.equals(value) && !ARCHIVED.equals(value))
            throw new IllegalArgumentException("笔记状态无效");
        return value;
    }

    private static String source(String value) {
        if (!"app".equals(value) && !"share".equals(value) && !"widget".equals(value) && !"shortcut".equals(value) && !"assistant".equals(value))
            throw new IllegalArgumentException("笔记入口无效");
        return value;
    }

    void add(Mode mode, String id, String text, Uri image, String source) throws Exception {
        validate(text, image != null);
        source(source);
        var db = this.db.getWritableDatabase();
        try (var found = db.query("notes", new String[]{"mode"}, "id = ?", new String[]{id}, null, null, null)) {
            if (found.moveToFirst()) {
                if (!mode.key.equals(found.getString(0))) throw new IllegalStateException("这条笔记已在另一模式保存");
                return; // The capture may be recreated after the commit.
            }
        }
        var values = new ContentValues();
        values.put("id", id);
        values.put("mode", mode.key);
        values.put("body", text);
        values.put("source", source);
        values.put("box", INBOX);
        if (image != null) {
            String mime = "content".equals(image.getScheme()) ? context.getContentResolver().getType(image) : null;
            if (mime == null || !mime.startsWith("image/")) throw new IllegalArgumentException("没有收到可读取的图片");
            var saved = files.importUris(context, id, owner(id), List.of(image));
            values.put("image", saved.getJSONArray("files").getJSONObject(0).getString("ref"));
        }
        long now = System.currentTimeMillis();
        values.put("created", now);
        values.put("modified", now);
        db.insertOrThrow("notes", null, values);
    }

    void addText(Mode mode, String id, String text, String source) throws Exception {
        add(mode, id, text, null, source);
    }

    void undoAssistantAdd(Mode mode, String id) {
        String[] key = {DiscussionFiles.id(id), mode.key};
        var db = this.db.getWritableDatabase();
        db.beginTransaction();
        try {
            int deleted = db.delete("notes", "id = ? AND mode = ? AND source = 'assistant' AND created = modified", key);
            if (deleted == 0) {
                try (var rows = db.query("notes", new String[]{"id"}, "id = ? AND mode = ?", key, null, null, null)) {
                    if (rows.moveToFirst()) throw new IllegalArgumentException("这条笔记已改动，请到笔记里管理");
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    JSONObject get(Mode mode, String id) throws JSONException {
        try (var cursor = this.db.getReadableDatabase().query("notes", FIELDS, "id = ? AND mode = ?", new String[]{DiscussionFiles.id(id), mode.key},
                null, null, null)) {
            if (!cursor.moveToFirst()) throw new IllegalArgumentException("这条笔记已不存在");
            return row(cursor);
        }
    }

    JSONObject list(Mode mode, String query, int offset, String box) throws JSONException {
        if (offset < 0 || offset % 30 != 0 || query.length() > 200) throw new IllegalArgumentException("笔记检索条件无效");
        String state = box.isEmpty() ? "" : box(box);
        JSONArray notes = new JSONArray();
        boolean more;
        String selection = "mode = ? AND (instr(lower(body), lower(?)) > 0 OR ? = '')" + (state.isEmpty() ? "" : " AND box = ?");
        String[] args = state.isEmpty() ? new String[]{mode.key, query, query} : new String[]{mode.key, query, query, state};
        try (var rows = this.db.getReadableDatabase().query("notes", new String[]{"id", "substr(body, 1, 150)", "image",
                "project", "source", "box", "created", "modified"}, selection, args, null, null,
                "created DESC, id DESC", offset + ",31")) {
            while (notes.length() < 30 && rows.moveToNext()) notes.put(row(rows));
            more = rows.moveToNext();
        }
        return new JSONObject().put("notes", notes).put("more", more).put("counts", counts(mode));
    }

    private JSONObject counts(Mode mode) throws JSONException {
        JSONObject counts = new JSONObject().put(INBOX, 0).put(FILED, 0).put(ARCHIVED, 0);
        try (var rows = this.db.getReadableDatabase().rawQuery("SELECT box, COUNT(*) FROM notes WHERE mode = ? GROUP BY box", new String[]{mode.key})) {
            while (rows.moveToNext()) counts.put(rows.getString(0), rows.getInt(1));
        }
        return counts;
    }

    int inboxCount(Mode mode) throws JSONException {
        return counts(mode).getInt(INBOX);
    }

    private static JSONObject row(Cursor cursor) throws JSONException {
        return new JSONObject().put("id", cursor.getString(0)).put("text", cursor.getString(1))
            .put("image", !cursor.isNull(2)).put("project", cursor.getString(3)).put("source", cursor.getString(4))
            .put("box", cursor.getString(5)).put("created", cursor.getLong(6)).put("modified", cursor.getLong(7));
    }

    JSONObject update(Mode mode, String id, String text, String project, String state) throws JSONException {
        JSONObject note = get(mode, id);
        validate(text, note.getBoolean("image"));
        if (project.length() > 512) throw new IllegalArgumentException("笔记项目无效");
        if (mode == Mode.LIFE && !project.isEmpty()) throw new IllegalArgumentException("生活笔记不能挂到工作项目");
        String next = state == null ? note.getString("box") : box(state);
        var values = new ContentValues();
        values.put("body", text);
        values.put("project", project);
        values.put("box", next);
        values.put("modified", Math.max(System.currentTimeMillis(), note.getLong("created") + 1));
        this.db.getWritableDatabase().update("notes", values, "id = ?", new String[]{id});
        return get(mode, id);
    }

    JSONObject setBox(Mode mode, String id, String state) throws JSONException {
        JSONObject note = get(mode, id);
        String next = box(state);
        var values = new ContentValues();
        values.put("box", next);
        values.put("modified", Math.max(System.currentTimeMillis(), note.getLong("created") + 1));
        this.db.getWritableDatabase().update("notes", values, "id = ?", new String[]{id});
        return get(mode, id);
    }

    void delete(Mode mode, String id) throws Exception {
        JSONObject note = get(mode, id);
        this.db.getWritableDatabase().delete("notes", "id = ?", new String[]{id});
        if (note.getBoolean("image")) files.discard(id);
    }

    void preview(Mode mode, Context activity, String id) throws Exception {
        JSONObject note = get(mode, id);
        if (!note.getBoolean("image")) throw new IllegalArgumentException("这条笔记没有图片");
        files.preview(activity, owner(id), id + ":0");
    }

    JSONArray branch(Mode mode, String id, String to) throws Exception {
        JSONObject note = get(mode, id);
        var refs = new JSONArray();
        if (note.getBoolean("image")) refs.put(id + ":0");
        return files.branch(owner(id), to, refs, note.getString("text"));
    }
}
