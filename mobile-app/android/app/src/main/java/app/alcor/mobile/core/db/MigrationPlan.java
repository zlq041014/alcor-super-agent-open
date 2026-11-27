package app.alcor.mobile.core.db;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Orders schema changes and fails loudly when a version step is missing. */
public final class MigrationPlan {
    public static final class Step {
        private final int version;
        private final List<String> statements;

        public Step(int version, List<String> statements) {
            if (version < 1) throw new IllegalArgumentException("迁移版本必须从 1 开始");
            if (statements == null || statements.isEmpty()) throw new IllegalArgumentException("迁移语句不能为空");
            this.version = version;
            this.statements = Collections.unmodifiableList(new ArrayList<>(statements));
        }

        public int version() {
            return version;
        }

        public List<String> statements() {
            return statements;
        }
    }

    private MigrationPlan() {
    }

    public static List<Step> between(int from, int to, List<Step> steps) {
        if (from < 0 || to < from) throw new IllegalArgumentException("数据库版本范围无效");
        List<Step> ordered = new ArrayList<>(steps);
        ordered.sort(Comparator.comparingInt(Step::version));
        Set<Integer> versions = new HashSet<>();
        for (Step step : ordered) {
            if (!versions.add(step.version())) throw new IllegalStateException("数据库迁移版本重复: v" + step.version());
        }
        List<Step> result = new ArrayList<>();
        for (int version = from + 1; version <= to; version++) {
            Step match = null;
            for (Step step : ordered) {
                if (step.version() == version) {
                    match = step;
                    break;
                }
            }
            if (match == null) throw new IllegalStateException("缺少数据库迁移: v" + version);
            result.add(match);
        }
        return result;
    }
}
