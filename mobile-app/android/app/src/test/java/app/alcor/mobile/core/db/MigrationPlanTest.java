package app.alcor.mobile.core.db;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public final class MigrationPlanTest {
    private static MigrationPlan.Step step(int version) {
        return new MigrationPlan.Step(version, Collections.singletonList("SELECT " + version));
    }

    @Test public void ordersStepsFromOldToNew() {
        List<MigrationPlan.Step> plan = MigrationPlan.between(1, 3, Arrays.asList(step(3), step(2)));
        assertEquals(2, plan.size());
        assertEquals(2, plan.get(0).version());
        assertEquals(3, plan.get(1).version());
    }

    @Test public void sameVersionNeedsNoStep() {
        assertEquals(0, MigrationPlan.between(3, 3, Collections.emptyList()).size());
    }

    @Test public void missingStepFailsLoudly() {
        IllegalStateException error = assertThrows(IllegalStateException.class,
            () -> MigrationPlan.between(1, 3, Collections.singletonList(step(2))));
        assertEquals("缺少数据库迁移: v3", error.getMessage());
    }

    @Test public void duplicateStepFailsLoudly() {
        assertThrows(IllegalStateException.class,
            () -> MigrationPlan.between(1, 2, Arrays.asList(step(2), step(2))));
    }

    @Test public void invalidRangeFails() {
        assertThrows(IllegalArgumentException.class,
            () -> MigrationPlan.between(3, 2, Collections.emptyList()));
    }

    @Test public void emptyStatementsRejected() {
        assertThrows(IllegalArgumentException.class,
            () -> new MigrationPlan.Step(2, Collections.emptyList()));
    }
}
