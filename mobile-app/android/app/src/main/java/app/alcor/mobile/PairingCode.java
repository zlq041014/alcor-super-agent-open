package app.alcor.mobile;

import java.util.regex.Pattern;

final class PairingCode {
    private static final Pattern CODE = Pattern.compile("ALCOR1[.][A-Za-z0-9_-]{1,1993}");

    static String require(String value) {
        String code = value.trim();
        if (!CODE.matcher(code).matches()) throw new IllegalArgumentException("请扫码或粘贴星引桌面生成的配对码");
        return code;
    }
}
