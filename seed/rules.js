'use strict';
// Правила чекера по умолчанию. Всё это редактируется в админ-панели.
// target: content (строки внутри .class) | path (пути файлов в jar) | name (имя файла / id / название мода)
// mode: any (любой из terms) | all (все terms) ; scope: class (в одном классе) | jar (во всём jar)
let n = 0;
const R = (name, severity, target, mode, terms, extra = {}) => ({
  id: 'r' + (++n), name, severity, target, mode, scope: 'class', caseSensitive: false, enabled: true, description: '', terms, ...extra
});

module.exports = [
  // --- Из старой версии чекера ---
  R('Reach (reachEnabled)', 'medium', 'content', 'any', ['reachEnabled'], { caseSensitive: true }),
  R('TriggerBot (triggerEnabled)', 'medium', 'content', 'any', ['triggerEnabled'], { caseSensitive: true }),
  R('AimAssist (adjustAim)', 'medium', 'content', 'any', ['adjustAim'], { caseSensitive: true }),
  R('Hitbox Forge (func_174826_a)', 'low', 'content', 'any', ['func_174826_a'], { caseSensitive: true, description: 'Маппинг-имя, встречается и в легальных модах — нужна ручная проверка.' }),
  R('Hitbox Fabric (method_5829 + class_238)', 'low', 'content', 'all', ['method_5829', 'class_238'], { caseSensitive: true }),
  R('Glow ESP Forge (func_184195_f)', 'low', 'content', 'any', ['func_184195_f'], { caseSensitive: true }),
  R('Hitbox LabyMod (dci + .cD())', 'low', 'content', 'all', ['dci', '.cD()'], { caseSensitive: true }),
  R('TriggerBot LabyMod (aot.a)', 'low', 'content', 'any', ['aot.a'], { caseSensitive: true, enabled: false, description: 'Выключено: слишком шумное правило. Включите, если нужно.' }),
  R('Glow ESP LabyMod (.bE)', 'low', 'content', 'any', ['.bE'], { caseSensitive: true, enabled: false, description: 'Выключено: слишком шумное правило. Включите, если нужно.' }),
  R('Обфускатор Allatori', 'medium', 'content', 'any', ['ALLATORIxDEMO'], { caseSensitive: true, scope: 'jar' }),

  // --- Модули читов по именам классов ---
  R('Модуль чита (по имени класса)', 'high', 'path', 'any',
    ['killaura', 'aimassist', 'triggerbot', 'autoclicker', 'clickaura', 'crystalaura', 'anchoraura', 'antiknockback', 'scaffold', 'noslowdown', 'autototem', 'autoarmor', 'fakelag', 'backtrack']),
  R('Структура чит-клиента (ClickGUI / ModuleManager)', 'medium', 'path', 'any', ['clickgui', 'modulemanager', 'hudeditor', 'module/combat', 'modules/combat', 'module/movement', 'modules/movement']),
  R('Пакеты известных клиентов', 'high', 'path', 'any',
    ['meteordevelopment', 'net/ccbluex', 'wurstclient', 'net/wurstclient', 'bleachhack', 'rusherhack', 'thunderhack', 'org/aristois', 'huzuni', 'nursultan', 'celestial', 'wexside', 'neverhook', 'doomsday']),

  // --- Названия клиентов / запрещённых модов (имя файла, id, название, Modrinth) ---
  R('Известный чит-клиент (по названию)', 'high', 'name', 'any',
    ['wurst', 'bleachhack', 'aristois', 'huzuni', 'skillclient', 'liquidbounce', 'meteor-client', 'meteorclient', 'nurik', 'nursultan', 'celestial', 'calestial', 'celka', 'neverhook', 'excellent', 'wexside', 'wildclient', 'deadcode', 'akrien', 'dreampool', 'norules', 'konas', 'richclient', 'rusherhack', 'thunderhack', 'moonhack', 'doomsday', 'nightware', 'extazyy', 'troxill', 'antileak', 'arbuz', 'dauntiblyat', 'takker', 'fuzeclient', 'wisefolder', 'aimbot', 'vec.dll', 'releondlc', 'simplevisuals', 'luminar', 'rockstar', 'catlean', 'nightdlc', 'ddnt']),
  R('Ограниченный мод (список Latest.log)', 'medium', 'name', 'any',
    ['baritone', 'accurateblockplacement', 'xray', 'autofish', 'chunkanimator', 'mobhealthbar', 'truesight', 'freecam', 'diamondgen', 'donutauctions', 'friendhighlighter', 'chesttracker', 'invisibilityreveal', 'playerhighlighter', 'playerspotlight', 'tweakeroo', 'autoharvest', 'flashback', 'worlddownloader', 'cmdcam', 'replaymod', 'litematica', 'block-entity-tooltip', 'xaerobetterpvp', 'removeblindness', 'auchelper', 'inventory_control_tweaks', 'autoleave', 'foodslot', 'quickstack', 'autotools', 'movement-in-gui', 'invmove', 'fireworkhelper', 'inventoryprofilesnext', 'effortlessbuilding', 'autoattack', 'elytraswap', 'elytra_swap', 'armor_hotswap', 'mob_hitbox', 'entity_outliner', 'viaversion', 'viafabric', 'viabackwards', 'viarewind', 'viaforge', 'viaproxy', 'vialoader', 'viamcp', 'clientcommands', 'swingthroughgrass', 'cutthrough'],
    { description: 'Совпадение даже для модов с Modrinth: легальный мод может быть запрещён правилами вашего сервера.' }),

  // --- Кража данных / вредоносное поведение ---
  R('Discord webhook внутри мода', 'high', 'content', 'any', ['discord.com/api/webhooks', 'discordapp.com/api/webhooks'], { scope: 'jar' }),
  R('Доступ к данным браузера', 'high', 'content', 'all', ['Login Data', 'Local State'], { caseSensitive: true, scope: 'jar' }),
  R('Доступ к токенам Discord', 'high', 'content', 'all', ['leveldb', 'Local Storage'], { scope: 'jar' }),
  R('Чтение аккаунтов лаунчера', 'medium', 'content', 'any', ['launcher_accounts.json', 'launcher_profiles.json'], { scope: 'jar' }),
  R('Запуск процессов + сеть', 'low', 'content', 'all', ['java/lang/ProcessBuilder', 'java/net/URL'], { scope: 'jar', caseSensitive: true }),
  R('Загрузка байт-кода (defineClass)', 'low', 'content', 'any', ['defineClass', 'java/lang/instrument'], { scope: 'jar', caseSensitive: true }),
  R('Встроенный .exe', 'medium', 'path', 'any', ['.exe']),
  R('Встроенная нативная библиотека', 'low', 'path', 'any', ['.dll', '.so', '.dylib'], { description: 'Нативные библиотеки есть и в легальных модах (sqlite, discord-rpc и т.д.).' }),

  // --- Обфускаторы ---
  R('Обфускаторы (Zelix / Stringer / Radon / Skidfuscator …)', 'low', 'content', 'any',
    ['ZKM', 'Zelix', 'Stringer', 'Skidfuscator', 'Paramorphism', 'Superblaze', 'qProtect', 'Branchlock', 'Radon', 'obfuscated by'], { scope: 'jar', caseSensitive: false })
];
