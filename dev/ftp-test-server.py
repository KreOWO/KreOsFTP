"""
Локальный FTP-сервер для проверки KreOsFTP без настоящего хостинга.

Запуск:  npm run test-server
Требует: pip install pyftpdlib

Слушает 127.0.0.1:2121, логин user / 12345.
Корень — dev/ftp-root/, при первом запуске туда кладутся тестовые файлы.
Сервер локальный и одноразовый: пароль здесь намеренно простой и не является
секретом — не используйте его нигде больше.
"""

import os
import sys

try:
    from pyftpdlib.authorizers import DummyAuthorizer
    from pyftpdlib.handlers import FTPHandler
    from pyftpdlib.servers import FTPServer
except ImportError:
    sys.exit("Не найден pyftpdlib. Установите его:\n\n    pip install pyftpdlib\n")

HOST = "127.0.0.1"
PORT = 2121
USER = "user"
PASSWORD = "12345"

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ftp-root")


def errno_of(err):
    """
    Достаёт настоящий код ошибки.

    pyftpdlib пересобирает исключение как `raise OSError(err)`, передавая
    исходное одним аргументом. У внешнего OSError из-за этого `errno` пуст,
    а реальный код лежит во вложенном исключении в args[0].
    """
    if err.errno is not None:
        return err.errno
    for arg in err.args:
        if isinstance(arg, OSError) and arg.errno is not None:
            return arg.errno
    return None


def seed(root):
    """Кладёт немного файлов и вложенную папку, чтобы было что перетаскивать."""
    os.makedirs(os.path.join(root, "docs", "вложенная папка"), exist_ok=True)
    files = {
        "readme.txt": "Это тестовый сервер KreOsFTP.\nПеретащите сюда файл или скачайте этот.\n",
        os.path.join("docs", "заметки.md"): "# Заметки\n\nФайл с кириллицей в имени и содержимом.\n",
        os.path.join("docs", "вложенная папка", "глубоко.txt"): "Третий уровень вложенности.\n",
    }
    for name, text in files.items():
        path = os.path.join(root, name)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)

    # Файл покрупнее — чтобы прогресс-бар и скорость было видно, а не мгновенный скачок.
    big = os.path.join(root, "большой-файл.bin")
    if not os.path.exists(big):
        with open(big, "wb") as f:
            f.write(os.urandom(8 * 1024 * 1024))


def main():
    # Python блочно буферизует stdout, когда это не терминал (запуск через npm,
    # перенаправление в файл, CI). Без этого приветствие с логином и портом
    # может не появиться до самого выхода.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    os.makedirs(ROOT, exist_ok=True)
    seed(ROOT)

    authorizer = DummyAuthorizer()
    # elradfmwMT = полный доступ: чтение, запись, создание, удаление, переименование.
    authorizer.add_user(USER, PASSWORD, ROOT, perm="elradfmwMT")

    handler = FTPHandler
    handler.authorizer = authorizer
    handler.banner = "KreOsFTP test server"

    # Порт захватывается до приветствия: печатать «запущен», а следом падать
    # трейсбеком — худшее, что может сделать скрипт.
    try:
        server = FTPServer((HOST, PORT), handler)
    except OSError as err:
        # 10048 — WSAEADDRINUSE (Windows), 48 — macOS, 98 — Linux.
        if errno_of(err) not in (10048, 48, 98):
            raise
        print("")
        print(f"  Порт {PORT} уже занят.")
        print("")
        print("  Скорее всего, тестовый сервер уже запущен в другом окне терминала.")
        print("  Если он вам нужен — просто пользуйтесь тем, что работает: адрес и")
        print("  логин те же. Если нет — остановите его через Ctrl+C в том окне,")
        print("  либо закройте процесс по номеру порта:")
        print("")
        print(f"    Windows:    Get-NetTCPConnection -LocalPort {PORT} -State Listen |")
        print("                  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }")
        print(f"    Linux/Mac:  kill $(lsof -ti tcp:{PORT})")
        print("")
        sys.exit(1)

    print("")
    print("  FTP-сервер для тестов запущен")
    print("  ─────────────────────────────")
    print(f"  Хост:         {HOST}")
    print(f"  Порт:         {PORT}")
    print(f"  Пользователь: {USER}")
    print(f"  Пароль:       {PASSWORD}")
    print(f"  Каталог:      {ROOT}")
    print("")
    print("  Остановить: Ctrl+C")
    print("")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")


if __name__ == "__main__":
    main()
