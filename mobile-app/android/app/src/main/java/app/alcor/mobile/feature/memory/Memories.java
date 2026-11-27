package app.alcor.mobile.feature.memory;

import app.alcor.mobile.core.Mode;
import app.alcor.mobile.core.db.Database;
import android.content.ContentValues;
import android.database.Cursor;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class Memories {
    private static final String[] FIELDS = {"id", "mode", "project", "body", "kind", "source", "source_ref", "created", "used", "enabled"};
    private final Database database;
    public Memories(Database database) { this.database = database; }

    private static String id(String value) {
        if (value == null || !value.matches("[a-f0-9]{32}")) throw new IllegalArgumentException("记忆编号无效");
        return value;
    }
    private static JSONObject row(Cursor c) throws JSONException {
        return new JSONObject().put("id", c.getString(0)).put("mode", c.getString(1)).put("project", c.getString(2))
            .put("text", c.getString(3)).put("kind", c.getString(4)).put("source", c.getString(5))
            .put("sourceRef", c.getString(6)).put("created", c.getLong(7)).put("used", c.isNull(8) ? JSONObject.NULL : c.getLong(8))
            .put("enabled", c.getInt(9) != 0);
    }
    private static String scope(Mode mode, String project) {
        if (project.length() > 512 || (mode == Mode.LIFE && !project.isEmpty()))
            throw new IllegalArgumentException("记忆范围无效");
        return project;
    }
    private static String body(String text) {
        String value = text.trim();
        if (value.isEmpty() || value.length() > 1000) throw new IllegalArgumentException("记忆内容需要 1 至 1000 字");
        return value;
    }
    public JSONArray list(Mode mode, String project, int offset) throws JSONException {
        if (offset < 0 || offset % 40 != 0) throw new IllegalArgumentException("记忆分页无效");
        JSONArray out = new JSONArray();
        try (var rows = database.getReadableDatabase().query("memories", FIELDS,
            "mode = ? AND project = ? AND deleted = 0", new String[]{mode.key, scope(mode, project)}, null, null,
            "kind ASC, created DESC, id DESC", offset + ",40")) {
            while (rows.moveToNext()) out.put(row(rows));
        }
        return out;
    }
    public JSONObject get(Mode mode, String value) throws JSONException {
        id(value);
        try (var rows = database.getReadableDatabase().query("memories", FIELDS,
            "id = ? AND mode = ? AND deleted = 0", new String[]{value, mode.key}, null, null, null)) {
            if (!rows.moveToFirst()) throw new IllegalArgumentException("这条记忆已不存在");
            return row(rows);
        }
    }
    public synchronized JSONObject add(Mode mode, String value, String text, String kind, String source, String sourceRef, String project) throws JSONException {
        String memoryId = id(value), content = body(text);
        if (!kind.matches("explicit|candidate") || !"chat".equals(source) || sourceRef.length() > 1024)
            throw new IllegalArgumentException("记忆内容或来源无效");
        JSONArray sourceMessage = new JSONArray(sourceRef);
        if (sourceMessage.length() != 2 || Mode.ofDialog(sourceMessage.getString(0)) != mode || sourceMessage.getString(1).isEmpty())
            throw new IllegalArgumentException("不能跨模式引用记忆来源");
        var db = database.getWritableDatabase();
        try (var rows = db.query("memories", new String[]{"id"}, "id = ?", new String[]{memoryId}, null, null, null)) {
            if (rows.moveToFirst()) return get(mode, memoryId);
        }
        var values = new ContentValues();
        values.put("id", memoryId); values.put("mode", mode.key); values.put("project", scope(mode, project));
        values.put("body", content); values.put("kind", kind); values.put("source", source); values.put("source_ref", sourceRef);
        values.put("created", System.currentTimeMillis()); values.put("enabled", "explicit".equals(kind) ? 1 : 0);
        db.insertOrThrow("memories", null, values);
        return get(mode, memoryId);
    }
    public synchronized JSONObject update(Mode mode, String value, String text, boolean enabled) throws JSONException {
        id(value);
        var values = new ContentValues(); values.put("body", body(text)); values.put("enabled", enabled ? 1 : 0);
        values.put("revised", 1);
        int n = database.getWritableDatabase().update("memories", values, "id = ? AND mode = ? AND deleted = 0 AND kind = 'explicit'", new String[]{value, mode.key});
        if (n != 1) throw new IllegalArgumentException("只有已确认的记忆可修改");
        return get(mode, value);
    }
    public synchronized JSONObject confirm(Mode mode, String value) throws JSONException {
        id(value);
        var values = new ContentValues(); values.put("kind", "explicit"); values.put("enabled", 1);
        database.getWritableDatabase().update("memories", values, "id = ? AND mode = ? AND deleted = 0 AND kind = 'candidate'", new String[]{value, mode.key});
        return get(mode, value);
    }
    public synchronized boolean delete(Mode mode, String value, boolean undo) throws JSONException {
        get(mode, value);
        var values = new ContentValues(); values.put("deleted", 1); values.put("enabled", 0);
        values.put("body", ""); values.put("source_ref", ""); values.put("project", ""); values.putNull("used");
        int n = database.getWritableDatabase().update("memories", values, "id = ? AND mode = ? AND deleted = 0" +
            (undo ? " AND revised = 0" : ""), new String[]{value, mode.key});
        if (n != 1) throw new IllegalArgumentException("记忆已修改，请在记忆页核对后删除");
        return true;
    }
    public JSONArray used(Mode mode, JSONArray ids) throws JSONException {
        if (ids.length() > 24) throw new IllegalArgumentException("记忆编号过多");
        var result = new JSONArray();
        if (ids.length() == 0) return result;
        String[] args = new String[ids.length() + 1]; args[0] = mode.key;
        StringBuilder placeholders = new StringBuilder("?");
        for (int i = 0; i < ids.length(); i++) {
            args[i + 1] = id(ids.getString(i));
            if (i != 0) placeholders.append(",?");
        }
        try (Cursor rows = database.getReadableDatabase().query("memories", FIELDS,
            "mode = ? AND deleted = 0 AND kind = 'explicit' AND id IN (" + placeholders + ")", args, null, null, "created DESC")) {
            while (rows.moveToNext()) result.put(row(rows));
        }
        return result;
    }
    /** Only enabled, confirmed entries are offered. Project lookups may also use general work memory. */
    public synchronized JSONArray context(Mode mode, String project, String query) throws JSONException {
        if (query.length() > 200) throw new IllegalArgumentException("记忆检索词过长");
        JSONArray result = new JSONArray();
        var db = database.getWritableDatabase();
        try (Cursor rows = db.query("memories", FIELDS,
            "mode = ? AND (project = '' OR project = ?) AND deleted = 0 AND enabled = 1 AND kind = 'explicit' " +
            "AND (? = '' OR instr(lower(body), lower(?)) > 0)",
            new String[]{mode.key, scope(mode, project), query, query}, null, null, "project DESC, created DESC, id DESC", "6")) {
            while (rows.moveToNext()) result.put(row(rows));
        }
        var used = new ContentValues(); used.put("used", System.currentTimeMillis());
        for (int i = 0; i < result.length(); i++)
            db.update("memories", used, "id = ?", new String[]{result.getJSONObject(i).getString("id")});
        return result;
    }
}
