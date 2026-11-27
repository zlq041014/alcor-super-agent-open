package app.alcor.mobile.core.net;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.junit.Test;

public final class ChatSseTest {
    @Test public void contentChunkCarriesDeltaText() throws Exception {
        ChatSse frame = ChatSse.parse("{\"choices\":[{\"delta\":{\"content\":\"你好\"},\"index\":0}]}");
        assertEquals("你好", frame.content());
        assertNull(frame.usage());
        assertNull(frame.title());
        assertTrue(!frame.done());
    }

    @Test public void finalChunkCarriesUsageAndTitleWithoutContent() throws Exception {
        ChatSse frame = ChatSse.parse("{\"choices\":[{\"delta\":{\"title\":\"周报整理\"},\"finish_reason\":\"stop\",\"index\":0}]," +
            "\"usage\":{\"prompt_tokens\":1234,\"completion_tokens\":56,\"total_tokens\":1290," +
            "\"prompt_cache_hit_tokens\":1000,\"prompt_cache_miss_tokens\":234," +
            "\"completion_tokens_details\":{\"reasoning_tokens\":12}}}");
        assertEquals("周报整理", frame.title());
        assertEquals(1234, frame.usage().getInt("prompt_tokens"));
        assertEquals(1000, frame.usage().getInt("prompt_cache_hit_tokens"));
        assertEquals(56, frame.usage().getInt("completion_tokens"));
        assertEquals(12, frame.usage().getJSONObject("completion_tokens_details").getInt("reasoning_tokens"));
        assertNull(frame.content());
    }

    @Test public void doneFrameIsTerminal() throws Exception {
        ChatSse frame = ChatSse.parse("[DONE]");
        assertTrue(frame.done());
        assertNull(frame.content());
    }

    @Test public void errorFrameExposesReason() throws Exception {
        ChatSse frame = ChatSse.parse("{\"error\":{\"message\":\"额度不足\"}}");
        assertEquals("额度不足", frame.error());
    }

    @Test public void usageOnlyFrameDoesNotInventContent() throws Exception {
        ChatSse frame = ChatSse.parse("{\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2}}");
        assertNull(frame.content());
        assertNull(frame.title());
        assertEquals(1, frame.usage().getInt("prompt_tokens"));
    }

    @Test public void nullDeltaIsIgnored() throws Exception {
        ChatSse frame = ChatSse.parse("{\"choices\":[{\"delta\":null,\"finish_reason\":\"length\"}]}");
        assertNull(frame.content());
        assertNull(frame.title());
    }

    @Test public void reasoningAndToolCallFragmentsAreExposed() throws Exception {
        ChatSse frame = ChatSse.parse("{\"choices\":[{\"delta\":{\"reasoning_content\":\"先查一下\",\"tool_calls\":[" +
            "{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"Deep\"}}]}}]}");
        assertEquals("先查一下", frame.reasoning());
        assertEquals("web_search", frame.toolCalls().getJSONObject(0).getJSONObject("function").getString("name"));
        assertNull(frame.content());
    }

    @Test public void malformedFrameFailsLoudly() {
        assertThrows(JSONException.class, () -> ChatSse.parse("not-json"));
        assertThrows(JSONException.class, () -> ChatSse.parse(" "));
    }
}
