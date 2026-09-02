/**
 * English catalog.
 *
 * Keys are the Russian source strings verbatim — see the note in `i18n.ts`.
 * A missing entry falls back to the Russian text rather than to a blank label,
 * so an incomplete translation stays usable instead of breaking the layout.
 *
 * `{0}`, `{1}` … are positional substitutions and must survive translation.
 * Plural forms are `|`-separated: Russian carries three, English two.
 */
export const EN: Record<string, string> = {
  // ── Общие действия и подписи ───────────────────────────────────────────────
  Отмена: 'Cancel',
  Отменить: 'Cancel',
  ОК: 'OK',
  Готово: 'Done',
  Сохранить: 'Save',
  Создать: 'Create',
  Добавить: 'Add',
  Удалить: 'Delete',
  Изменить: 'Edit',
  Переименовать: 'Rename',
  Повторить: 'Retry',
  Очистить: 'Clear',
  Пропустить: 'Skip',
  Перезаписать: 'Overwrite',
  Докачать: 'Resume',
  'Обзор…': 'Browse…',
  'Поиск…': 'Search…',
  'Фильтр…': 'Filter…',
  'Диск…': 'Drive…',
  Домой: 'Home',
  Имя: 'Name',
  Размер: 'Size',
  Изменён: 'Modified',
  Правила: 'Rules',
  Путь: 'Path',
  Источник: 'Source',
  Приёмник: 'Target',
  Назначение: 'Destination',
  'по умолчанию': 'default',
  'Все файлы': 'All files',

  // ── Единицы и время ────────────────────────────────────────────────────────
  Б: 'B',
  КБ: 'KB',
  МБ: 'MB',
  ГБ: 'GB',
  ТБ: 'TB',
  '0 Б': '0 B',
  '{0}/с': '{0}/s',
  '{0} с': '{0} s',
  '{0} мин {1} с': '{0} min {1} s',
  '{0} ч {1} мин': '{0} h {1} min',
  'объект|объекта|объектов': 'object|objects',
  ' · скрыто {0}': ' · {0} hidden',
  'Выбрано {0}{1}': 'Selected {0}{1}',

  // ── Панели и навигация ─────────────────────────────────────────────────────
  Локально: 'Local',
  Сервер: 'Server',
  Подключения: 'Connections',
  'Каталог пуст': 'Folder is empty',
  'Ничего не найдено': 'Nothing found',
  'Ничего не найдено по фильтру': 'Nothing matches the filter',
  'Загрузка…': 'Loading…',
  'Вверх (Backspace)': 'Up (Backspace)',
  'Обновить (F5)': 'Refresh (F5)',
  'Переименовать (F2)': 'Rename (F2)',
  'Удалить (Delete)': 'Delete (Delete)',
  'Новая папка': 'New folder',
  'Имя папки': 'Folder name',
  'Новое имя': 'New name',
  'Открыть в проводнике': 'Show in file manager',
  'Выберите папку': 'Choose a folder',
  'Путь ({0})': 'Path ({0})',
  'Фильтр списка ({0})': 'Filter the list ({0})',
  'Изменить ширину столбца': 'Resize column',
  'Изменить высоту панели': 'Resize panel',
  'Показать/скрыть панель подключений': 'Show or hide the connections panel',

  // ── Подключение ────────────────────────────────────────────────────────────
  Подключиться: 'Connect',
  Отключиться: 'Disconnect',
  'Подключение…': 'Connecting…',
  'Подключено: {0}': 'Connected: {0}',
  Отключено: 'Disconnected',
  'Новое подключение': 'New connection',
  'Изменить подключение': 'Edit connection',
  'Параметры подключения': 'Connection settings',
  'Изменить профиль': 'Edit profile',
  'Удалить профиль': 'Delete profile',
  'Удалить профиль «{0}»?': 'Delete the profile “{0}”?',
  'Нет активного подключения': 'Not connected',
  'Выберите сервер слева или': 'Pick a server on the left, or',
  'создайте новый профиль': 'create a new profile',
  'Пока нет сохранённых подключений.': 'No saved connections yet.',
  Нажмите: 'Press',
  ', чтобы добавить сервер.': ' to add a server.',
  'Поиск подключения': 'Search connections',
  'Закрыть соединение': 'Close the connection',
  'Убрать из панели': 'Remove from the bar',
  'Не подключено — нажмите, чтобы подключиться': 'Not connected — click to connect',
  'Не удалось подключиться к «{0}»': 'Could not connect to “{0}”',
  'Ожидание ответа сервера.': 'Waiting for the server to answer.',
  'Профиль подключения не найден': 'Connection profile not found',
  'Сессия закрыта': 'Session closed',
  'Сессия не найдена — возможно, соединение уже закрыто':
    'Session not found — the connection may already be closed',
  'Соединение закрыто': 'Connection closed',
  'Соединение установлено: {0} {1}:{2}': 'Connected: {0} {1}:{2}',
  'Соединение установлено: SFTP {0}:{1}': 'Connected: SFTP {0}:{1}',
  'FTP-соединение закрыто': 'The FTP connection is closed',
  'SFTP-соединение закрыто': 'The SFTP connection is closed',
  'SSH-соединение закрыто': 'The SSH connection is closed',
  'Подключение к {0}:{1} по SFTP…': 'Connecting to {0}:{1} over SFTP…',
  'Не удалось открыть {0}: {1}. Открываю домашний каталог.':
    'Could not open {0}: {1}. Falling back to the home folder.',

  // ── Форма профиля ──────────────────────────────────────────────────────────
  Название: 'Name',
  Хост: 'Host',
  Порт: 'Port',
  'Порт SSH': 'SSH port',
  Протокол: 'Protocol',
  Пользователь: 'User',
  Пароль: 'Password',
  'Пароль для {0}': 'Password for {0}',
  'Пароль ключа': 'Key passphrase',
  Аутентификация: 'Authentication',
  Анонимно: 'Anonymous',
  анонимно: 'anonymous',
  'Приватный ключ': 'Private key',
  'Приватные ключи': 'Private keys',
  'SSH-агент (Pageant / ssh-agent)': 'SSH agent (Pageant / ssh-agent)',
  'Выберите приватный SSH-ключ': 'Choose an SSH private key',
  'Запомнить пароль': 'Remember the password',
  '•••••••• (сохранён)': '•••••••• (saved)',
  'если ключ без пароля — оставьте пустым': 'leave empty if the key has no passphrase',
  'Каталог на сервере': 'Remote folder',
  'Локальный каталог': 'Local folder',
  'Стартовая локальная папка': 'Starting local folder',
  'Мой сервер': 'My server',
  'Принимать самоподписанные сертификаты': 'Accept self-signed certificates',
  'Закреплённый ключ хоста:': 'Pinned host key:',
  'Ввести пароль заново': 'Enter the password again',
  'Введённый пароль будет использован для этого подключения':
    'The password you type is used for this connection only',
  'Введите пароль заново — он будет перезаписан.':
    'Enter the password again — it will be overwritten.',
  'Откройте профиль и введите пароль заново.':
    'Open the profile and enter the password again.',
  'Обычный FTP передаёт пароль и данные открытым текстом. По возможности выбирайте\n                SFTP или FTPS.':
    'Plain FTP sends the password and your data in the clear. Prefer SFTP or FTPS where you can.',
  'Пароли шифруются средствами ОС и хранятся только на этом компьютере.':
    'Passwords are encrypted by the operating system and never leave this computer.',
  'Пароли шифруются средствами ОС (DPAPI) и привязаны к вашей учётной записи Windows.':
    'Passwords are encrypted by the OS keystore and tied to your user account.',
  'Системное хранилище секретов недоступно — пароли не сохраняются.':
    'The OS keystore is unavailable — passwords are not saved.',
  'Системное хранилище секретов недоступно, поэтому пароль сохранён не будет — его\n              придётся вводить при каждом подключении.':
    'The OS keystore is unavailable, so the password will not be saved — you will have to type it on every connection.',
  'Сохранённый секрет не удалось расшифровать ({0}). ':
    'The saved secret could not be decrypted ({0}). ',
  'Пароль не задан: сохранённого нет или его не удалось расшифровать. ':
    'No password available: none is saved, or it could not be decrypted. ',
  'Не указан путь к приватному ключу': 'No private key path is set',
  'Не указан путь к приватному SSH-ключу': 'No SSH private key path is set',
  'SSH не поддерживает анонимный вход — укажите пользователя и пароль или ключ':
    'SSH has no anonymous login — provide a user with a password or a key',

  // ── Протоколы ──────────────────────────────────────────────────────────────
  'FTP (незашифрованный)': 'FTP (unencrypted)',
  'FTPS (явный TLS)': 'FTPS (explicit TLS)',
  'FTPS (неявный TLS)': 'FTPS (implicit TLS)',
  'SFTP (поверх SSH)': 'SFTP (over SSH)',
  'Сервер поздоровался как FTP («{0}»), а не как SSH. ':
    'The server greeted us as FTP (“{0}”), not as SSH. ',
  'Сервер поздоровался как SSH («{0}»), а не как FTP. ':
    'The server greeted us as SSH (“{0}”), not as FTP. ',
  'Измените протокол подключения на FTP или FTPS.': 'Change the protocol to FTP or FTPS.',
  'Измените протокол подключения на SFTP.': 'Change the protocol to SFTP.',

  // ── Ключи хоста ────────────────────────────────────────────────────────────
  'Ключ хоста запомнен при первом подключении: {0}':
    'Host key pinned on first connection: {0}',
  'Ключ SSH-хоста запомнен: {0}': 'SSH host key pinned: {0}',
  'Ключ SSH-хоста изменился. Ожидался {0}, получен {1}':
    'The SSH host key changed. Expected {0}, got {1}',
  'Отпечаток ключа хоста не совпал. Ожидался {0}, получен {1}. ':
    'Host key fingerprint mismatch. Expected {0}, got {1}. ',
  'Соединение разорвано — это может быть подмена сервера.':
    'Connection dropped — this may be a server impersonation.',

  // ── Передачи ───────────────────────────────────────────────────────────────
  'В работе': 'Active',
  История: 'History',
  Журнал: 'Log',
  'Журнал пуст': 'The log is empty',
  'История передач пуста.': 'No transfers yet.',
  'Активных передач нет. Выберите файлы и нажмите стрелку между панелями — или перетащите их.':
    'No active transfers. Select files and press an arrow between the panels — or drag them across.',
  'в очереди': 'queued',
  'идёт': 'running',
  'готово': 'done',
  ошибка: 'failed',
  'отменён': 'cancelled',
  подготовка: 'preparing',
  'Подготовка списка': 'Building the list',
  'Загрузка на сервер': 'Upload',
  Скачивание: 'Download',
  'Загрузить выделенные файлы на сервер': 'Upload the selected files',
  'Скачать выделенные файлы с сервера': 'Download the selected files',
  'Убрать завершённые из списка': 'Remove finished entries',
  'Параллельные передачи': 'Parallel transfers',
  'Параллельные передачи: {0}': 'Parallel transfers: {0}',
  'Каждая параллельная передача использует отдельное соединение с сервером.':
    'Each parallel transfer opens its own connection to the server.',
  'Не удалось открыть параллельное соединение: {0}':
    'Could not open a parallel connection: {0}',
  '[передача] {0}': '[transfer] {0}',
  'Удалено: {0}': 'Deleted: {0}',
  'Создан каталог {0}': 'Created folder {0}',
  'Переименовано: {0} → {1}': 'Renamed: {0} → {1}',
  'Не удалось создать {0}: {1}': 'Could not create {0}: {1}',

  // ── Конфликты ──────────────────────────────────────────────────────────────
  'Файл уже существует': 'File already exists',
  'На сервере уже есть {0}.': 'The server already has {0}.',
  'Локально уже есть {0}.': 'You already have {0} locally.',
  'Применить ко всем оставшимся файлам': 'Apply to all remaining files',
  'Правило для остальных': 'Rule for the rest',
  'То же действие': 'The same action',
  'Докачать недостающую часть': 'Transfer only the missing part',
  'Докачка возможна только для неполного файла':
    'Resuming is possible only for an incomplete file',
  'Если файл уже существует': 'When the file already exists',
  'Спрашивать каждый раз': 'Ask every time',
  'Всегда перезаписывать': 'Always overwrite',
  'Всегда пропускать': 'Always skip',
  'Всегда докачивать': 'Always resume',
  'Заменить, если отличается размер': 'Replace when the size differs',
  'Заменить, если источник новее': 'Replace when the source is newer',
  'Заменить, если отличается размер или источник новее':
    'Replace when the size differs or the source is newer',
  'Файлы одинакового размера пропускаются. Быстро, но не заметит правку, ':
    'Files of equal size are skipped. Fast, but blind to an edit ',
  'не изменившую длину файла.': 'that did not change the length.',
  'Заменяется только то, что в источнике свежее. Совпадение с точностью до ':
    'Only a fresher source replaces the target. Timestamps within ',
  'двух секунд считается одним и тем же временем.': 'two seconds count as the same moment.',
  'Самое строгое из трёх: достаточно любого признака различия. Пропускается ':
    'The strictest of the three: either difference is enough. Only files matching ',
  'только то, что совпало и по размеру, и по дате.': 'on both size and date are skipped.',
  'Пропущено — файл уже существует': 'Skipped — the file already exists',
  'Пропущено — размер совпадает': 'Skipped — the size matches',
  'Пропущено — источник не новее': 'Skipped — the source is not newer',
  'Пропущено — размер совпадает, источник не новее':
    'Skipped — same size, and the source is not newer',
  'Сервер не сообщает время изменения файлов, сравнить по дате невозможно — ':
    'The server does not report modification times, so dates cannot be compared — ',
  'правило «если новее» работает как обычная перезапись.':
    'the “if newer” rule behaves as a plain overwrite.',

  // ── Перетаскивание ─────────────────────────────────────────────────────────
  'Куда передать': 'Choose a destination',
  'Куда передать?': 'Where to?',
  'Объект брошен на папку {0}.': 'One item dropped on the folder {0}.',
  'Объектов брошено: {0}, папка назначения — {1}.': '{0} items dropped on the folder {1}.',
  'Внутрь папки': 'Into the folder',
  'Внутрь «{0}»': 'Into “{0}”',
  'В текущий каталог': 'Into the current folder',
  'Отклонено неподтверждённое перетаскивание локальных файлов':
    'Rejected an unverified drag of local files',
  'Отклонено неподтверждённое перетаскивание файлов сервера':
    'Rejected an unverified drag of server files',
  'Список перетаскиваемых файлов устарел или подделан':
    'The dragged file list is stale or forged',

  // ── Синхронизация ──────────────────────────────────────────────────────────
  'Обновить сервер': 'Update the server',
  'Обновить локально': 'Update local',
  'Обновить сервер?': 'Update the server?',
  'Обновить локальную папку?': 'Update the local folder?',
  'Обновить сервер с учетом .ftpignore': 'Update the server, honouring .ftpignore',
  'Обновить локально с учетом .ftpignore': 'Update local files, honouring .ftpignore',
  'Подготовка обновления сервера': 'Preparing the server update',
  'Подготовка обновления локальной папки': 'Preparing the local update',
  'Локальная версия заменит отличающиеся файлы на сервере.':
    'The local version will replace differing files on the server.',
  'Серверная версия заменит отличающиеся локальные файлы.':
    'The server version will replace differing local files.',
  'Сравнение выполняется по наличию, типу и размеру. Лишние файлы в назначении не удаляются.':
    'Comparison uses presence, type and size. Extra files at the destination are left alone.',
  'Чтение .ftpignore, обход каталогов и сравнение размеров':
    'Reading .ftpignore, walking the tree and comparing sizes',
  'Локальный .ftpignore': 'Local .ftpignore',
  'Серверный .ftpignore': 'Server .ftpignore',
  '.ftpignore больше 1 МБ': '.ftpignore is larger than 1 MB',
  'Предпросмотр отменён': 'Preview cancelled',
  'Не удалось рассчитать подсветку: {0}': 'Could not compute the highlight: {0}',
  'В очередь добавлено: {0}; без изменений: {1}; исключено: {2}':
    'Queued: {0}; unchanged: {1}; excluded: {2}',
  'Версии совпадают. Без изменений: {0}; исключено: {1}':
    'Versions match. Unchanged: {0}; excluded: {1}',
  'Обновление сервера: в очередь {0}, без изменений {1}, ':
    'Server update: {0} queued, {1} unchanged, ',
  'Обновление локальной версии: в очередь {0}, ': 'Local update: {0} queued, ',
  'без изменений {0}, исключено {1}.': '{0} unchanged, {1} excluded.',
  'исключено {0}.': '{0} excluded.',
  'Синхронизация ограничена {0} объектов': 'Sync is limited to {0} items',
  'Синхронизация ограничена 100 000 объектов': 'Sync is limited to 100,000 items',
  'Слишком глубокое дерево каталогов на сервере': 'The server folder tree is too deep',
  'Слишком глубокое дерево локальных каталогов': 'The local folder tree is too deep',
  'Сервер вернул небезопасное имя: {0}': 'The server returned an unsafe name: {0}',
  'Сервер вернул повторяющееся имя: {0}': 'The server returned a duplicate name: {0}',
  'Сервер вернул циклический каталог: {0}': 'The server returned a folder loop: {0}',
  'Путь выходит за пределы выбранной папки: {0}':
    'The path escapes the selected folder: {0}',
  'Недопустимое имя файла: {0}': 'Invalid file name: {0}',
  'Недопустимый объём данных терминала': 'Invalid terminal payload size',
  'Имя файла недопустимо в Windows: {0}': 'This file name is invalid on Windows: {0}',
  'Зарезервированное имя Windows: {0}': 'Reserved Windows name: {0}',

  // ── SSH-терминал ───────────────────────────────────────────────────────────
  'Открыть SSH-терминал': 'Open the SSH terminal',
  'Открыть SSH-терминал внутри серверной панели':
    'Open the SSH terminal inside the server panel',
  'Закрыть SSH-терминал': 'Close the SSH terminal',
  'Изменить высоту SSH-терминала': 'Resize the SSH terminal',
  'SSH-терминал {0}': 'SSH terminal {0}',
  'SSH-терминал не подключён': 'The SSH terminal is not connected',
  'SSH-терминал уже подключается': 'The SSH terminal is already connecting',
  '[90mПодключение SSH…[0m': '[90mConnecting over SSH…[0m',
  'Копировать выделенный текст': 'Copy the selection',
  'Вставить из буфера обмена': 'Paste from the clipboard',
  'Добавить быструю SSH-команду': 'Add a quick SSH command',
  'Изменить быструю команду': 'Edit the quick command',
  'Удалить быструю команду': 'Delete the quick command',
  'Удалить команду {0}': 'Delete the command {0}',
  'Новая быстрая команда': 'New quick command',
  'Закрыть редактор быстрых команд': 'Close the quick command editor',
  'Название, например Статус': 'A name, for example Status',
  'Выполнить: {0}': 'Run: {0}',
  'Название команды должно быть от 1 до 40 символов':
    'The command name must be 1 to 40 characters',
  'Команда должна быть от 1 до 4096 символов': 'The command must be 1 to 4096 characters',
  'Слишком много быстрых команд': 'Too many quick commands',
  'Некорректный идентификатор команды': 'Invalid command identifier',

  // ── Настройки ──────────────────────────────────────────────────────────────
  Настройки: 'Settings',
  'Язык интерфейса': 'Interface language',
  Тема: 'Theme',
  'Тёмная': 'Dark',
  Светлая: 'Light',
  'Как в системе': 'Match the system',
  'Показывать скрытые файлы (начинающиеся с точки)': 'Show hidden files (dot files)',
  'Подтверждать удаление': 'Confirm before deleting',

  // ── Подтверждения и удаление ───────────────────────────────────────────────
  'Удалить {0} {1}?': 'Delete {0} {1}?',
  '{0}{1}\n\nДействие необратимо.': '{0}{1}\n\nThis cannot be undone.',
  '\n…и ещё {0}': '\n…and {0} more',
  '{0}:{1}\n\nСохранённый пароль тоже будет удалён.':
    '{0}:{1}\n\nThe saved password will be deleted too.',

  // ── GitHub ─────────────────────────────────────────────────────────────────
  'Открыть репозиторий проекта на GitHub': 'Open the project repository on GitHub',
  'Ветка: {0} · коммит {1}': 'Branch: {0} · commit {1}',
  'Незакоммиченных файлов: {0}': 'Uncommitted files: {0}',
  'Рабочая копия чистая': 'Working tree is clean',
  'Доступно обновление: на сервере коммит {0}': 'Update available: remote is at {0}',
  'Обновлений нет': 'Up to date',
  'Состояние сервера неизвестно — нет связи или доступа':
    'Remote state unknown — offline or no access',
  'Адрес репозитория не определён': 'Repository URL is unknown',
  'Клик — открыть в браузере': 'Click to open in the browser',
  'Разрешены только ссылки http и https': 'Only http and https links are allowed',

  // ── Версия и обновление ────────────────────────────────────────────────────
  'Дождитесь завершения текущих передач перед обновлением версии':
    'Wait for the running transfers to finish before updating',
  'Сравнение версии {0} → {1}…': 'Comparing {0} → {1}…',

  // ── Диагностика (консоль разработчика) ─────────────────────────────────────
  'Не найден корневой элемент #root': 'Root element #root not found',
  '[preload] ошибка в {0}:': '[preload] error in {0}:',
  '[renderer] загрузка не удалась ({0} {1}): {2}': '[renderer] load failed ({0} {1}): {2}',
  '[renderer] процесс завершился:': '[renderer] process gone:'
}
