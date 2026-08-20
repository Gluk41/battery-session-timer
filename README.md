==================================================
 Battery Session Timer – GNOME Shell Extension
==================================================

Назначение | Purpose
----------
**Русский:** Отображает время работы ноутбука от аккумулятора в панели GNOME. Сохраняет рекорд времени работы между сессиями.
Время сна (гибернации) НЕ учитывается – отсчёт ведётся только активного времени работы на батарее.

**English:** Displays the laptop's battery runtime in the GNOME panel. Saves the session time record between sessions.
Sleep time (hibernation) is NOT counted – only active battery time is tracked.

---

Возможности | Features
-----------
**Русский:**
• Отображение времени работы от батареи в панели (иконка + время)
• Автоматический выбор иконки в зависимости от уровня заряда
• Поддержка режимов питания (батарея / сеть)
• Сохранение рекорда времени работы между сессиями
• Сохранение текущей сессии при перезагрузке и восстановление (если питание не подключалось)
• Время сна не учитывается — учитывается только активное время
• Четыре варианта размещения в панели:
    - Слева (после кнопки «Обзор»)
    - По центру (перед часами)
    - По центру (после часов)
    - Справа (перед системными индикаторами)
• Меню на русском языке
• Поддержка GNOME Shell 45–50

**English:**
• Display battery runtime in the panel (icon + time)
• Automatic icon selection based on charge level
• Power mode support (battery / AC)
• Session record persistence between sessions
• Session state saved across reboots and restored if still on battery
• Sleep time is excluded — only active battery time is tracked
• Four panel placement options:
    - Left (after Activities button)
    - Center (before clock)
    - Center (after clock)
    - Right (before system indicators)
• Russian language menu
• GNOME Shell 45–50 support

---

Установка | Installation
---------
**Русский:**
Способ 1. Установка через gnome-extensions (рекомендуемый)
  Скачайте battery-session-timer-gnome.zip и переместите в домашнюю папку (home)
  Выполните в терминале:
       gnome-extensions install --force ~/battery-session-timer-gnome.zip
  После этого выйдите из системы и войдите снова (или перезагрузите компьютер).
  Откройте менеджер расширений и включите расширение. Расширение появится в панели.

Способ 2. Ручная установка (из ZIP-архива)
  1. Скачайте архив расширения.
  2. Распакуйте архив в каталог расширений пользователя:
       mkdir -p ~/.local/share/gnome-shell/extensions
       cd ~/.local/share/gnome-shell/extensions
       unzip ~/Загрузки/battery-session-timer-gnome.zip
     (замените путь к ZIP-архиву на фактический)
  3. Выйдите из системы и войдите снова (или перезагрузите компьютер),
     чтобы оболочка GNOME применила изменения.
  4. Включите расширение:
       gnome-extensions enable battery-session-timer@local

**English:**
Method 1. Install via gnome-extensions (recommended)
  Download battery-session-timer-gnome.zip and move it to your home folder
  Run in terminal:
       gnome-extensions install --force ~/battery-session-timer-gnome.zip
  Then log out and log back in (or reboot).
  Open the Extensions app and enable the extension. It will appear in the panel.

Method 2. Manual installation (from ZIP archive)
  1. Download the extension archive.
  2. Extract the archive to the user extensions directory:
       mkdir -p ~/.local/share/gnome-shell/extensions
       cd ~/.local/share/gnome-shell/extensions
       unzip ~/Загрузки/battery-session-timer-gnome.zip
     (replace the ZIP path with the actual one)
  3. Log out and log back in (or reboot) to apply changes.
  4. Enable the extension:
       gnome-extensions enable battery-session-timer@local

---

Настройка | Configuration
---------
**Русский:**
После установки щёлкните по иконке в панели, чтобы открыть меню:
  • Текущая сессия – отображает время работы от батареи.
  • Рекорд – максимальное время работы за одну сессию.
  • Пункты положения – выберите, где разместить индикатор.
  • Сбросить рекорд – обнуляет сохранённый рекорд.

**English:**
After installation, click the panel icon to open the menu:
  • Current session – displays battery runtime.
  • Record – the longest session time ever.
  • Position items – choose where to place the indicator.
  • Reset record – clears the saved record.

---

Файлы данных | Data files
---------
**Русский:**
Настройки и данные сохраняются в файлах:
  ~/.config/battery-session-timer-record          – рекорд (в секундах)
  ~/.config/battery-session-timer-session.json    – состояние текущей сессии
  ~/.config/battery-session-timer-settings.json   – положение в панели
Удалите их, если хотите полностью очистить данные.

**English:**
Settings and data are stored in:
  ~/.config/battery-session-timer-record          – record (in seconds)
  ~/.config/battery-session-timer-session.json    – current session state
  ~/.config/battery-session-timer-settings.json   – panel position
Delete them to completely reset all data.

---

Удаление | Removal
---------
**Русский:**
  gnome-extensions disable battery-session-timer@local
  rm -rf ~/.local/share/gnome-shell/extensions/battery-session-timer@local

**English:**
  gnome-extensions disable battery-session-timer@local
  rm -rf ~/.local/share/gnome-shell/extensions/battery-session-timer@local

---

Совместимость | Compatibility
---------
**Русский:**
• GNOME Shell версии 45, 46, 47, 48, 49, 50.
• Поддерживаемые дистрибутивы: любые с GNOME (Ubuntu, Fedora, Bazzite, Arch Linux, openSUSE и другие).
• Требуется UPower и logind (обычно присутствуют по умолчанию).

**English:**
• GNOME Shell versions 45, 46, 47, 48, 49, 50.
• Supported distributions: any with GNOME (Ubuntu, Fedora, Bazzite, Arch Linux, openSUSE, and others).
• Requires UPower and logind (usually present by default).

---

Лицензия | License
---------
**Русский:**
Это расширение распространяется под лицензией GNU General Public License v3.0.
Подробности см. в файле LICENSE в репозитории.

**English:**
This extension is distributed under the GNU General Public License v3.0.
See the LICENSE file in the repository for details.

---

Автор | Author
-----
**Gluk41** (https://github.com/Gluk41)
