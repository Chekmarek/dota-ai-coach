"""Собирает пакет для друга: release/friend-kit/DotaCoach-<версия>-friend-kit.zip (папка release/ — вне git).

В пакете:
  CLAUDE_PROMPT.md  — промпт для Claude Code (шаблон docs/FRIEND_PROMPT.md с подставленной версией): влить свежий
                      `sources` в свои правки, ничего не потеряв;
  ЧТО_НОВОГО.md     — заметки к релизам после версии друга (docs/release-notes), новые сверху;
  КАК_ОБНОВИТЬ.txt  — обновить установленного коуча: «Обновления» → «Установить», руками ничего не нужно.

Запуск из корня репозитория:  python tools/make_friend_kit.py [--since 0.17.0]
"""
import argparse, io, json, os, re, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES = os.path.join(ROOT, "docs", "release-notes")


def ver(s):
    return tuple(int(x) for x in s.split("."))


def main():
    ap = argparse.ArgumentParser(description="Пакет для друга")
    ap.add_argument("--since", default="0.17.0", help="версия, которая сейчас у друга (заметки — после неё)")
    args = ap.parse_args()

    version = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))["version"]
    template = open(os.path.join(ROOT, "docs", "FRIEND_PROMPT.md"), encoding="utf-8").read()
    if "{VERSION}" not in template:
        sys.exit("docs/FRIEND_PROMPT.md: нет {VERSION} — это не шаблон")
    prompt = template.replace("{VERSION}", version)

    notes = []
    for f in os.listdir(NOTES):
        m = re.fullmatch(r"v(\d+\.\d+\.\d+)\.md", f)
        if m and ver(args.since) < ver(m.group(1)) <= ver(version):
            notes.append((ver(m.group(1)), m.group(1), open(os.path.join(NOTES, f), encoding="utf-8").read().strip()))
    if not any(v == version for _, v, _ in notes):
        sys.exit(f"нет docs/release-notes/v{version}.md")
    notes.sort(reverse=True)
    changes = f"# Что нового: {args.since} → {version}\n\n" + "\n\n".join(f"## {v}\n\n{t}" for _, v, t in notes) + "\n"

    howto = (
        f"Dota AI Coach {version}\r\n\r\n"
        "Обновить установленного коуча: открыть коуча → «Обновления» → «Установить». Больше ничего делать не нужно:\r\n"
        "заменяется только app.asar, настройки, история и прогресс сохраняются, settings.json править не надо.\r\n\r\n"
        "CLAUDE_PROMPT.md нужен, только если у тебя свои правки в исходниках: скопируй его в Claude Code в папке\r\n"
        "своего клона dota-ai-coach.\r\n"
    )

    out_dir = os.path.join(ROOT, "release", "friend-kit")
    os.makedirs(out_dir, exist_ok=True)
    zpath = os.path.join(out_dir, f"DotaCoach-{version}-friend-kit.zip")
    name = f"DotaCoach-{version}-friend-kit"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}/CLAUDE_PROMPT.md", prompt.encode("utf-8"))
        z.writestr(f"{name}/ЧТО_НОВОГО.md", changes.encode("utf-8"))
        z.writestr(f"{name}/КАК_ОБНОВИТЬ.txt", howto.encode("utf-8-sig"))
    print(f"{os.path.relpath(zpath, ROOT)}  {os.path.getsize(zpath)} байт")
    print(f"  заметки к релизам: {', '.join(v for _, v, _ in notes)}")


if __name__ == "__main__":
    main()
