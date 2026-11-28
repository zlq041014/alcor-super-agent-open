package app.alcor.mobile;

import java.util.HashMap;
import org.json.JSONObject;

/** A locally verified reason that the current input cannot be sent as selected. */
final class InputIssue extends IllegalArgumentException {
    private final String code;
    private final String ref;

    InputIssue(String code, String message, String ref) {
        super(message);
        this.code = code;
        this.ref = ref;
    }

    JSONObject bridgeValue() {
        var data = new HashMap<String, String>();
        data.put("code", code);
        data.put("message", getMessage());
        if (ref != null) data.put("ref", ref);
        return new JSONObject(data);
    }
}
