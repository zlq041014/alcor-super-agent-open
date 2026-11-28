package app.alcor.mobile;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class PairingCodeTest {
    @Test public void scanAndPasteAcceptTheSameBoundedInvitationFormat() {
        assertEquals("ALCOR1.fixture_-", PairingCode.require(" \nALCOR1.fixture_-\t"));
        String max = "ALCOR1." + "a".repeat(1993);
        assertEquals(max, PairingCode.require(max));
        for (String invalid : new String[] {"", "https://example.invalid/", "ALCOR1.", "ALCOR1.stale+code", max + "a"}) {
            assertThrows(IllegalArgumentException.class, () -> PairingCode.require(invalid));
        }
    }
}
