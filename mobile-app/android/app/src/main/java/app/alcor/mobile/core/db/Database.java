package app.alcor.mobile.core.db;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.List;

/** The single business database. Schema changes go through MigrationPlan so every version has a path. */
public final class Database extends SQLiteOpenHelper {
    public static final int VERSION = 8;
    private static final List<MigrationPlan.Step> MIGRATIONS = List.of(
        new MigrationPlan.Step(2, List.of(
            "CREATE INDEX IF NOT EXISTS notes_project_recent ON notes(project, created DESC)")),
        new MigrationPlan.Step(3, List.of(
            "ALTER TABLE notes ADD COLUMN box TEXT NOT NULL DEFAULT 'inbox'",
            "CREATE INDEX notes_box_recent ON notes(box, created DESC, id DESC)")),
        new MigrationPlan.Step(4, List.of(
            "CREATE TABLE dialogs (id TEXT PRIMARY KEY, position INTEGER NOT NULL, kind TEXT NOT NULL, " +
                "title TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', peer TEXT NOT NULL DEFAULT '', " +
                "used INTEGER NOT NULL DEFAULT 0, messages_present INTEGER NOT NULL DEFAULT 1, " +
                "decisions_present INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)",
            "CREATE TABLE messages (dialog TEXT NOT NULL, origin TEXT NOT NULL, id TEXT NOT NULL, " +
                "position INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, " +
                "kind TEXT, data TEXT NOT NULL, PRIMARY KEY (dialog, origin, id))",
            "CREATE INDEX messages_dialog ON messages(dialog, origin, position)",
            "CREATE TABLE decisions (dialog TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, " +
                "data TEXT NOT NULL, PRIMARY KEY (dialog, id))",
            "CREATE TABLE work (id TEXT PRIMARY KEY, position INTEGER NOT NULL, dialog TEXT NOT NULL, " +
                "project TEXT NOT NULL, stage TEXT NOT NULL, peer TEXT NOT NULL DEFAULT '', data TEXT NOT NULL)",
            "CREATE TABLE peers (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)",
            "CREATE TABLE projects (key TEXT PRIMARY KEY, position INTEGER NOT NULL, peer TEXT NOT NULL DEFAULT '', " +
                "id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL)",
            "CREATE TABLE artifacts (key TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)",
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")),
        new MigrationPlan.Step(5, List.of(
            "CREATE TABLE reminders (id TEXT PRIMARY KEY, body TEXT NOT NULL, due INTEGER NOT NULL, " +
                "origin TEXT NOT NULL, origin_ref TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, " +
                "state TEXT NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','posted','blocked','cancelled')))",
            "CREATE INDEX reminders_state_due ON reminders(state, due, id)")),
        new MigrationPlan.Step(6, List.of(
            "ALTER TABLE notes ADD COLUMN mode TEXT NOT NULL DEFAULT 'work' CHECK (mode IN ('work','life'))",
            "CREATE INDEX notes_mode_recent ON notes(mode, created DESC, id DESC)",
            "ALTER TABLE reminders ADD COLUMN mode TEXT NOT NULL DEFAULT 'work' CHECK (mode IN ('work','life'))",
            "CREATE INDEX reminders_mode_due ON reminders(mode, state, due, id)")),
        new MigrationPlan.Step(7, List.of(
            "CREATE TABLE memories (id TEXT PRIMARY KEY, mode TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', " +
                "body TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('explicit','candidate')), source TEXT NOT NULL, " +
                "source_ref TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER, enabled INTEGER NOT NULL DEFAULT 1, " +
                "revised INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0)",
            "CREATE INDEX memories_scope ON memories(mode, project, deleted, enabled, kind, created DESC)")),
        new MigrationPlan.Step(8, List.of(
            "CREATE TABLE work_notice_delivery (id TEXT PRIMARY KEY, seq INTEGER NOT NULL)")));
    public Database(Context context) {
        this(context, "assistant.db");
    }

    public Database(Context context, String name) {
        super(context, name, null, VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        createNotesV1(db);
        Migrations.upgrade(db, 1, VERSION, MIGRATIONS);
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        Migrations.upgrade(db, oldVersion, newVersion, MIGRATIONS);
    }

    @Override public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("数据库版本高于当前应用，请更新星引");
    }

    /** The notes schema as first shipped. Kept for upgrade tests and fresh installs. */
    public static void createNotesV1(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, image TEXT, " +
            "project TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created INTEGER NOT NULL, modified INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX notes_recent ON notes (created DESC, id DESC)");
    }
}
