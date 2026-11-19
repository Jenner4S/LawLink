#!/usr/bin/env sh
# 启动一个带 CDP 调试端口的独立 Chrome，供 scripts/verify-ui.mjs 使用。
#
# 为什么单独一个脚本：verify-ui.mjs 通过 CDP 驱动浏览器，需要一个已开着远程调试
# 的实例。用临时 profile，避免碰到日常浏览器的登录态与扩展。
set -e

PORT="${CDP:-9333}"
PROFILE="${VERIFY_PROFILE:-/tmp/lawlink-verify-profile}"

case "$(uname)" in
  Darwin)
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ;;
  *)
    CHROME="${CHROME_BIN:-google-chrome}"
    ;;
esac

if [ ! -x "$CHROME" ] && ! command -v "$CHROME" >/dev/null 2>&1; then
  echo "找不到 Chrome：$CHROME" >&2
  echo "用 CHROME_BIN=/path/to/chrome 指定" >&2
  exit 1
fi

if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "CDP 已在 $PORT 运行，无需重启"
  exit 0
fi

rm -rf "$PROFILE"
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --headless=new \
  --window-size=1440,900 \
  about:blank >/dev/null 2>&1 &

sleep 2
if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "CDP 就绪：http://127.0.0.1:$PORT"
else
  echo "CDP 启动失败，检查 Chrome 是否可用" >&2
  exit 1
fi
