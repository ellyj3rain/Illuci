"""
illuci - agy pseudo-console helper.

Google Antigravity's `agy` CLI renders its response only to a real terminal; on a
plain (non-TTY) stdout it emits nothing (upstream antigravity-cli bug #76). This
helper hands agy a Windows pseudo-console (ConPTY, via pywinpty) so it renders, then
captures the stream, strips ANSI / spinner / control noise, and writes the clean
response to a UTF-8 file the illuci `agy.js` bridge reads.

Usage:  py agy_pty.py <out_file> <agy args...>
  e.g.  py agy_pty.py out.txt --print "hello" --model "Gemini 3.1 Pro (Low)" --print-timeout 60s

agy binary resolves from AGY_PATH, else the default AppData install location.
"""
import sys
import os
import re
import time
import winpty

AGY = os.environ.get("AGY_PATH") or os.path.expandvars(r"%LOCALAPPDATA%\agy\bin\agy.exe")
HARD_LIMIT_S = int(os.environ.get("AGY_PTY_LIMIT_S", "180"))


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: agy_pty.py <out_file> <agy args...>\n")
        sys.exit(2)
    out_file = sys.argv[1]
    args = sys.argv[2:]

    try:
        proc = winpty.PtyProcess.spawn([AGY] + args)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("SPAWN_ERR: %r\n" % (e,))
        sys.exit(3)

    buf = ""
    start = time.monotonic()
    while (time.monotonic() - start) < HARD_LIMIT_S:
        if not proc.isalive():
            try:
                d = proc.read()
                if d:
                    buf += d
            except Exception:  # noqa: BLE001
                pass
            break
        try:
            d = proc.read()
        except EOFError:
            break
        except Exception:  # noqa: BLE001
            break
        if d:
            buf += d

    clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", buf)      # CSI / SGR sequences
    clean = re.sub(r"\x1b\][^\x07]*\x07", "", clean)         # OSC sequences
    clean = re.sub(r"[⠀-⣿]", "", clean)            # braille spinner frames
    clean = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", clean)  # stray control chars

    with open(out_file, "w", encoding="utf-8") as f:
        f.write(clean.strip())


if __name__ == "__main__":
    main()
