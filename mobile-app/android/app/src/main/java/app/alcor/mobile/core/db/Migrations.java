package app.alcor.mobile.core.db;

import android.database.sqlite.SQLiteDatabase;
import java.util.List;

public final class Migrations {
    private Migrations() {
    }

    public static void upgrade(SQLiteDatabase db, int from, int to, List<MigrationPlan.Step> steps) {
        for (MigrationPlan.Step step : MigrationPlan.between(from, to, steps)) {
            for (String sql : step.statements()) db.execSQL(sql);
        }
    }
}
