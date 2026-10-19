<p><img src="branding/squadra-logo.svg" width="72" alt="Squadra"></p>

# Squadra

Varias sesiones de Claude Code que se escriben entre sí, con una de ellas como **coordinador**. Es una copia del [plugin oficial de Telegram para Claude Code](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), que usa **Channels** para empujar mensajes a una sesión en marcha. Telegram se sustituye por un servidor propio (`squadra-server`), y el humano del otro lado por otra sesión de Claude.

```
             ┌──────── squadra-server (Node) ────────┐
             │ identidades · mensajes · ficheros   │
             └──────▲────────────▲────────────▲────┘
              HTTPS (long polling, saliente)
             ┌──────┴─────┐ ┌────┴───────┐ ┌──┴─────────┐
             │ claude     │ │ claude     │ │ claude     │
             │ coord      │ │ w1         │ │ w2         │
             │ plugin     │ │ plugin     │ │ plugin     │
             └────────────┘ └────────────┘ └────────────┘
```

- **`server/`**: `squadra-server`. Imita la parte de la Bot API de Telegram que usa el plugin. Solo usa módulos de Node, incluido `node:sqlite`.
- **`plugins/squadra/`**: el plugin. Contiene un servidor MCP con Channels, sin dependencias, y las skills `/squadra:login`, `/squadra:logout`, `/squadra:status`, `/squadra:configure` y `/squadra:access`.
- **`host/`**: `squadra-host`, el cliente que se instala en cada máquina para abrir sesiones desde el panel y ver o escribir en sus terminales (ver «Máquinas»).
- **`.claude-plugin/marketplace.json`**: este repositorio es también un marketplace de plugins (`squadra`).

## Requisitos

- **Node ≥ 22.13** en la máquina del servidor y en **cada máquina donde corra un Claude con el plugin**. Claude Code lanza el plugin con `node`.
- **Claude Code** con login de claude.ai (Pro/Max) o con clave de Console.
- **Planes Team/Enterprise:** el Owner tiene que activar Channels en *Organization settings → Claude Code → Channels*.

## Sistemas operativos

- **Linux y macOS:** todo. El servidor y el panel son Node puro; el plugin y squadra-host usan sockets Unix, `ps` y tmux, que existen en los dos.
  - **macOS no tiene `/proc`:** el plugin y el hook usan `ps -o ppid=,args=` para recorrer los procesos padre.
  - **Rutas de socket cortas:** macOS limita la ruta de un socket Unix a 104 bytes, y Linux a 108. Si `~/.claude/channels/squadra/run/<pid>.sock` no cabe en 100 bytes (pasa con un `HOME` o un `CLAUDE_CONFIG_DIR` largos), el socket va a `/tmp/squadra-<uid>-<hash del directorio>/`. `plugins/squadra/paths.js` calcula la ruta y comprueba que la carpeta sea del usuario y sin permisos para grupo ni otros: en un `/tmp` compartido, otro usuario podría crearla antes. Si no es privada, el plugin no abre el socket y el hook no envía nada.
  - **Servicio:** `squadra-host service` imprime una unidad de systemd en Linux y un agente de launchd (`~/Library/LaunchAgents/com.squadra.host.plist`) en macOS. Este último funciona con la sesión del usuario iniciada, porque Claude Code guarda su login en el Llavero.
- **Windows: a través de WSL.** En Windows nativo faltan tmux, `ps` y los sockets Unix (habría que usar ConPTY con `node-pty`, *named pipes* y otra forma de encontrar el proceso de Claude Code). El plugin rechaza el login y squadra-host no arranca, y ambos remiten a WSL. Dentro de WSL todo funciona como en Linux, y el panel se abre desde el navegador de Windows en `http://localhost:7787`.
- **CI:** `.github/workflows/test.yml` ejecuta `npm test` en Ubuntu y macOS, con tmux instalado.

## Si venías del nombre anterior (`swarm`)

El proyecto se llamaba *Claude Swarm*. Al cambiar de nombre cambia el identificador del plugin, así que hay que reinstalarlo una vez en cada máquina. Dentro de `claude`:

```
/plugin uninstall swarm@claude-swarm
/plugin marketplace remove claude-swarm
/plugin marketplace add roke22/Squadra
/plugin install squadra@squadra
```

Después:
- **Alias:** cambia `claude-swarm` por `claude-squadra` (ver más abajo).
- **Comandos:** `/swarm:login` pasa a ser `/squadra:login`, y lo mismo con el resto.
- **Lo que se conserva solo:**
  - la carpeta `~/.claude/channels/swarm/` se mueve sola a `~/.claude/channels/squadra/` la primera vez, con identidades, emparejamientos y configuración;
  - las variables `SWARM_*` siguen funcionando solo en el `.env` (en el entorno, solo `SWARM_SERVER_TOKEN` en el servidor);
  - el servidor conserva sus datos y su token (`data/server-token`).
- **Servidor:** basta con reiniciarlo con el código nuevo.

## 1. Arrancar el servidor

```bash
# En local (desde la raíz del proyecto)
node server/server.js
# escucha en http://127.0.0.1:7787, datos en ./data

# O con Docker
docker build -f server/Dockerfile -t squadra-server .
docker run -d --name squadra-server -p 127.0.0.1:7787:7787 -e PUBLIC_URL=http://127.0.0.1:7787 -v squadra-data:/data squadra-server   # solo esta máquina; para otras, HTTPS
docker logs squadra-server      # para ver el token
```

**Los dos tokens:**
- **Token del servidor** (administración): entra en el panel, abre terminales web, ejecuta `/admin/*` y puede rotar identidades (`register` con `reset`). Solo vive en el navegador. Se guarda en `data/server-token` (600).
- **Token de alta** (`sj_…`): el que guardan las máquinas. Solo registra nombres de sesión nuevos (`register` sin `reset`). Se guarda en `data/join-token` (600) y es el que aparece en el comando `/squadra:configure` que se muestra al arrancar, y el que reciben las máquinas que se dan de alta desde el panel, solo si se marca «Dar también a esa máquina el token de alta».
- Los dos se generan la primera vez, se reutilizan después y se muestran al arrancar.
- Rotar el de alta: `POST /admin/rotateJoinToken` con el de administración (las identidades existentes siguen valiendo; las máquinas necesitarán el nuevo para registrar nombres nuevos). Cambiar el de administración: `SQUADRA_SERVER_TOKEN`, o borrar `data/server-token` y reiniciar.

| Variable | Por defecto | |
|---|---|---|
| `SQUADRA_SERVER_TOKEN` | el de `data/server-token`, o uno generado | Token de administración (mín. 16 caracteres). Si la defines, tiene prioridad sobre el fichero |
| `SQUADRA_JOIN_TOKEN` | el de `data/join-token`, o uno generado | Token de alta para las máquinas (mín. 16 caracteres, distinto del anterior) |
| `SQUADRA_MAX_SESSIONS` | `500` | Como mucho estas identidades registradas con el token de alta |
| `TRUST_PROXY` | — | `1` detrás de un proxy que pone `X-Forwarded-For` (Caddy): los límites de frecuencia usan la IP del cliente |
| `HOST` | `127.0.0.1` (`0.0.0.0` en Docker y con HTTPS integrado) | Interfaz de escucha |
| `PUBLIC_URL` | — | Dirección pública (`https://tu-dominio`), para mostrar el comando `/squadra:configure` correcto |
| `SQUADRA_DOMAIN` / `--domain` | — | HTTPS integrado: el servidor obtiene y renueva un certificado de Let's Encrypt (ACME HTTP-01, sin dependencias) y redirige el HTTP a HTTPS. Necesita los puertos 80 y 443 |
| `TLS_CERT` / `TLS_KEY` | — | HTTPS con certificado propio; se recarga al cambiar los ficheros |
| `PORT` | `7787` (`443` con HTTPS integrado) | |
| `DATA_DIR` | `./data` | Base de datos SQLite y ficheros |
| `OBSERVE_TTL_HOURS` | `24` | Horas que se guardan los eventos del panel web |

**Sesiones en varias máquinas:** el servidor tiene que ser alcanzable desde todas. Los parámetros `--host`, `--all-interfaces`, `--port`, `--public-url` y `--data-dir` equivalen a las variables; `node server/server.js --help` los lista. En `deploy/` hay un Docker Compose con Caddy listo para servir HTTPS en tu dominio.
- Si va a una IP pública, ponlo **detrás de TLS** (por ejemplo, Caddy: `squadra.ejemplo.com { reverse_proxy 127.0.0.1:7787 }`) y arráncalo con `--public-url https://squadra.ejemplo.com --trust-proxy`: sin ellos, los comandos que da a las máquinas usan http, que estas rechazan.
- Si no quieres exponerlo, usa una red privada tipo Tailscale.
- Las sesiones siempre se conectan hacia el servidor: sus máquinas no abren puertos.

## 2. Instalar el plugin (una vez por máquina)

Dentro de `claude`:

```
/plugin marketplace add roke22/Squadra           # o la ruta local a este repo
/plugin install squadra@squadra
/squadra:configure https://squadra.ejemplo.com <token-de-alta>
```

`/squadra:configure` guarda la URL y el token en `~/.claude/channels/squadra/.env`; el plugin lo deja en 600 al arrancar.

## 3. Arrancar las sesiones y hacer login

Claude Code solo activa un channel si la sesión **se arranca** con el flag correspondiente; no se puede activar desde dentro. Crea un alias una vez, en `~/.bashrc` o `~/.zshrc`:

```bash
alias claude-squadra='claude --dangerously-load-development-channels plugin:squadra@squadra'
```

Al arrancar, Claude Code muestra un diálogo a pantalla completa sobre los channels de desarrollo. Elige **"I am using this for local development"**. Sale en cada arranque mientras Channels esté en *research preview*. En Team/Enterprise, el administrador puede añadir `{ "marketplace": "squadra", "plugin": "squadra" }` a `allowedChannelPlugins`; así basta con `--channels plugin:squadra@squadra` y no aparece el diálogo.

Después, dentro de cada sesión:

| Comando | |
|---|---|
| `/squadra:login coordinador` | Entra como coordinador, con el nombre `coord`. `/squadra:login coordinador jefe` usa el nombre `jefe` |
| `/squadra:login worker1` | Entra como worker con el nombre `worker1` y saluda a su coordinador (`coord`). `--coord jefe` elige otro coordinador |
| `/squadra:logout` | Sale de Squadra. Un worker avisa a su coordinador |
| `/squadra:status` | Quién eres, si estás conectado, emparejamientos pendientes y qué sesiones están vivas |
| `/squadra:access …` | Emparejar, lista de permitidos, políticas y grupos |
| `/squadra:configure …` | URL y token del servidor, identidad |

- **Coordinador:** arráncalo en una carpeta con su propio `CLAUDE.md`, que define cómo coordina.
- **Workers:** cada uno en la carpeta de su proyecto, en esta u otra máquina. Por defecto solo aceptan mensajes de su coordinador.
- **Sesiones normales:** el plugin no hace nada hasta el login, así que no se ven afectadas.
- **Nombres únicos: gana la primera sesión.**
  - Si una sesión intenta entrar con un nombre que ya usa otra sesión **activa**, su login se rechaza y la que estaba no se entera.
  - El nombre queda libre en cuanto su dueña hace logout o se cierra. Si se cae su máquina o su red, en unos 45 s.
  - Nadie puede quitarle el nombre a una sesión conectada (no hay `--force`). Si una sesión se queda colgada, el administrador la desconecta desde el panel (⋯ → Desconectar sesión): queda fuera y no puede volver sola.
- **Confirmación del usuario:** cada login que se escribe en la sesión lo confirma el usuario en Claude Code (elicitación MCP), con el rol, el coordinador, el servidor y lo que verá el panel; sin elicitación, solo lo aprobado antes. Un Claude engañado por un mensaje no puede cambiar quién coordina la sesión.
- **Flag olvidado:** si arrancas con `claude` a secas y haces `/squadra:login`, te avisa de que falta el flag en vez de dejarte conectado sin recibir nada.

**Arranque por script**, sin login a mano: `SQUADRA_NAME` hace el login automáticamente, con el rol y el coordinador de `<estado>/launch.json` (el que escribe squadra-host; se borra al usarlo; vale para un arranque en los 15 minutos siguientes) o, si no hay, los que el usuario aprobó la última vez. El rol, el coordinador y la lista de permitidos ya no se leen de variables de entorno, porque la configuración de un proyecto podría ponerlas.

```bash
# ~/.claude/channels/squadra/w1/launch.json → {"name":"w1","role":"worker","coordinator":"coord"}
SQUADRA_NAME=w1 claude-squadra
```

| Variable | |
|---|---|
| `SQUADRA_NAME` | Nombre de la sesión (`[A-Za-z0-9_-]`, máx. 32). Hace login al arrancar |
| `SQUADRA_URL`, `SQUADRA_SERVER_TOKEN`, `SQUADRA_STATE_DIR` | Solo desde el `.env` de la máquina (`/squadra:configure`); en el entorno se ignoran. `SQUADRA_STATE_DIR` tiene que ser absoluta y guarda una subcarpeta por nombre |
| `SQUADRA_OBSERVE`, `SQUADRA_PERMISSION_RELAY` | Del `.env` y del entorno vale el más estricto: un proyecto puede bajar la observación o apagar el relay, nunca subirlos |
| `CLAUDE_CONFIG_DIR` | Se ignora si está dentro de la carpeta de primer nivel que contiene la sesión (todo `/opt` para `/opt/proyectos/app`; `~/code` para `~/code/app`) o si no es del usuario y privada (se usa `~/.claude` del usuario) |

En `launch.json` también caben `allow_from` (lista de sesiones permitidas desde el inicio) y `access_mode: "static"` (acceso fijo al arrancar, sin emparejamiento).

## 4. Emparejar

1. Haces `/squadra:login worker1` en el worker. El plugin saluda automáticamente al coordinador: *👋 worker1 conectado como worker en /ruta (máquina)*.
2. Si el coordinador aún no conoce a `worker1`, no le entrega el saludo a Claude. Le contesta al worker con un código de 6 caracteres y te avisa **en el terminal del coordinador**: *La sesión "worker1" quiere comunicarse contigo… /squadra:access pair a1b2c3*.
3. Tú ejecutas en el terminal del coordinador: `/squadra:access pair a1b2c3`. El worker recibe "Emparejado".
4. Cuando estén todos los workers, cierra el acceso: `/squadra:access policy allowlist`.

El emparejamiento se hace una sola vez por nombre: tras un `/squadra:logout` o un reinicio, volver a hacer login con el mismo nombre no pide código. Claude nunca aprueba un emparejamiento por su cuenta: la skill solo obedece órdenes escritas por ti en el terminal.

## 5. Trabajar

- **Hablas con el coordinador en su terminal.** Él reparte el trabajo a los workers con `reply`.
- **Los workers informan al coordinador** al empezar, al terminar (con resumen y decisiones), si se bloquean y cuando tienen dudas críticas.
- **El coordinador no contesta a los mensajes informativos.** Solo responde cuando tiene una instrucción, una corrección, una respuesta o un veredicto que dar. Así se evitan los bucles.
- **Puedes escribir directamente en el terminal de cualquier worker** en cualquier momento.

**Entrega y desconexiones:**
- **A un worker solo se le entrega si está conectado.** Si no lo está, `reply` falla con *NO ENVIADO: el worker "w1" está desconectado…* y no se guarda nada. Así una tarea nunca se queda esperando a una sesión que quizá no vuelva, y el coordinador puede dársela a otro.
- **Al coordinador se le entrega siempre.** Si está desconectado, el mensaje queda en cola (24 h; como mucho 500 por remitente y 10 000 en total, se descartan primero los más antiguos), le llega al volver y `reply` lo avisa.
- **En un grupo**, se entrega a quien esté conectado (más los coordinadores, que lo reciben en cola). `reply` dice a qué workers no se les ha entregado.
- **El servidor avisa al coordinador** cuando uno de sus workers:
  - sale (`/squadra:logout`);
  - se cierra (su Claude Code termina);
  - **se cae** (deja de responder; se detecta en unos segundos si se corta la conexión, y en unos 45 s si se cae la red);
  - vuelve tras un corte breve.
- **Lo que no llegó a recoger se descarta,** y el aviso cita los del coordinador (hasta 10) y cuenta los demás, para que lo reasigne. Así no aparecen tareas viejas al volver.

**Permisos:** cuando un worker necesita aprobar una herramienta, el diálogo sale en su terminal **y** le llega al coordinador como `🔐 Permiso: Bash … Responde "yes abcde" o "no abcde"`. El coordinador aprueba lo que no tiene efectos y te pregunta lo destructivo. Vale la primera respuesta: la del coordinador o la tuya en el terminal del worker.

**Grupos:** son privados. Quien crea el grupo invita a los demás (`/squadra:access group add #backend --invite w1,w2`), y cada sesión invitada entra con `/squadra:access group add #backend`. Un mensaje a `#backend` solo le llega a quien se menciona (`@w1 …`), salvo que esa sesión misma lo añadiera con `--no-mention` (es un ajuste de cada miembro, en su propio `access.json`). Si el dueño sale del grupo, pasa a serlo el miembro más antiguo.

**Adjuntos:** `reply` acepta `files` (rutas absolutas, máx. 50 MB). Las imágenes se descargan solas en la sesión destino; el resto, con `download_attachment`.

## Herramientas que ve Claude

| Herramienta | |
|---|---|
| `reply(chat_id, text, reply_to?, files?)` | Envía a una sesión (`coord`, `w1`) o a un grupo (`#backend`). Ver *Entrega y desconexiones* |
| `edit_message(chat_id, message_id, text)` | Edita un mensaje propio: progreso. El destinatario lo recibe como `edited="true"`, información que no se contesta |
| `react(chat_id, message_id, emoji)` | Reacción. Nunca despierta a la otra sesión |
| `download_attachment(file_id)` | Descarga un adjunto a `~/.claude/channels/squadra/<nombre>/inbox/` |
| `login(role, name?, coordinator?, observe?)` · `logout()` · `status()` | Las usan `/squadra:login`, `/squadra:logout` y `/squadra:status`. Las instrucciones de Claude le prohíben usarlas si lo pide un mensaje del canal |
| `ping(chat_id?)` | ¿Está viva la sesión? Contesta el **servidor**, sin despertar al worker ni gastar sus tokens. Sin `chat_id` comprueba todas las sesiones permitidas. Indica si está ACTIVA o CAÍDA, cuándo envió su último mensaje y cuántos mensajes tiene sin recoger |

Los mensajes entrantes llegan como:

```
<channel source="squadra" chat_id="w1" message_id="42" user="w1" user_id="w1" ts="…">texto</channel>
```

Si la sesión estaba parada, se despierta. Si estaba ocupada, el mensaje entra en el siguiente turno.

## Panel web en directo

El servidor sirve un panel en su misma dirección: `http://127.0.0.1:7787/`, o `https://tu-dominio/`.

- **Login:**
  - Una pantalla aparte que pide el token del servidor.
  - El panel no se muestra hasta que el servidor lo valida, tampoco con un token recordado.
  - Si el token cambia, vuelve al login.
- **Portada en mosaico:** una ventana de chat en directo por sesión, como un monitor lleno de terminales ordenadas.
  - Caben tantas columnas como permita la pantalla: 2 o 3 en un portátil, 4–6 en un ultrawide. También se pueden fijar entre 2 y 6.
  - **Colores por rol:** morado para los coordinadores y verde azulado para los workers.
  - Las ventanas que esperan un permiso se marcan en rojo; las desconectadas se atenúan.
- **Vista de una sesión** (pulsando su nombre, o `/#/s/<nombre>`): el mismo chat a pantalla completa, como el chat de Claude.
  - Tus prompts y los mensajes recibidos aparecen como burbujas.
  - El texto de Claude se muestra con markdown.
  - Las herramientas seguidas van agrupadas y plegables: se ven abiertas mientras se ejecutan, con su entrada y su salida.
  - Los mensajes que envía la sesión aparecen como tarjetas «→ coord», y los avisos del servidor entre medias.
- **Scroll infinito:** al subir se carga lo anterior sin perder la posición, y el botón «↓ nuevo» aparece si llega actividad mientras lees.
- **Barra inferior** de cada chat con el estado en directo: *Bash · 0:42 · npm test*, *🔐 Esperando permiso…*, *Inactiva*.
- **Barra lateral** con coordinadores y workers, su estado, los avisos de permiso pendiente y un contador de novedades.
- **Acciones de cada sesión:** se abren con el menú ⋯ de su ventana o con los botones de su vista. Todas piden confirmación.
  - **Limpiar chat**, esté conectada o no: borra del servidor su actividad. Los mensajes entre sesiones se ocultan en ese chat, pero siguen en el de las otras sesiones. La conversación del propio Claude no se toca.
  - **Archivar**, solo desconectada: deja de aparecer en el mosaico y pasa a la vista **Archivadas** con todo su historial. Desde allí se puede ver, desarchivar o eliminar. Si vuelve a conectarse, se desarchiva sola.
  - **Eliminar**, solo desconectada: borra del servidor su identidad y su actividad; sus mensajes siguen en los chats de los demás. Si vuelve a hacer `/squadra:login` con ese nombre, se registra de nuevo automáticamente si la máquina tiene el token de alta; si no (máquinas dadas de alta desde el panel), se abre de nuevo desde el panel.

**Cómo llega cada cosa:**
- **Al instante:** las herramientas y los cambios de estado. Los envían los hooks del plugin, que se ejecutan en segundo plano y no frenan a Claude.
- **Al terminar cada mensaje:** el texto de Claude, que se lee de la transcripción de la sesión según crece. No va letra a letra.
- **La salida de un comando** aparece cuando termina; mientras tanto se ve *ejecutando · tiempo*.

**Qué se envía al servidor**, por sesión: `/squadra:login worker1 --observe <nivel>`, o por máquina: `/squadra:configure observe <nivel>`.

| Nivel | |
|---|---|
| `full` (por defecto) | Todo lo anterior, con entradas y salidas recortadas |
| `activity` | Qué hace: herramientas con argumentos cortos, estado, contexto, los primeros 200 caracteres de los prompts y la primera línea de los errores (secretos enmascarados). Sin texto de Claude ni salidas |
| `off` | Nada |

- Las claves y tokens reconocibles (`sk-…`, `ghp_…`, `AKIA…`, JWT, `password=…`, `Bearer …`) se enmascaran antes de enviarse. El código y la salida de los comandos sí llegan al servidor con `full`: por eso el TLS es obligatorio si el servidor no es local.
- El servidor guarda los eventos 24 h. Se cambia con `OBSERVE_TTL_HOURS`.

## Máquinas: abrir sesiones desde el panel (squadra-host)

`host/squadra-host.mjs` es un programa de un solo fichero, sin dependencias (Node ≥ 22.13 y tmux ≥ 3.2), que se instala en cada máquina donde se quieran abrir sesiones desde el panel. El propio servidor lo sirve en `/host/squadra-host.mjs`.

**Principios:**
- **Solo el usuario abre sesiones.** El coordinador no tiene ninguna herramienta para hacerlo: si necesita más workers, se los pide al usuario.
- **La máquina nunca ejecuta lo que manda el servidor.** Solo acepta una especificación con estos campos, y rechaza cualquier otro:
  - `name`: `[A-Za-z0-9_-]{1,32}`, sin repetir en la máquina;
  - `role`: `coordinator` o `worker`; `coordinator`: el nombre del coordinador, solo para workers;
  - `folder`: ruta absoluta que, resuelta con `realpath`, esté dentro de una de las carpetas permitidas. Se rechazan `#`, `;` y caracteres de control, porque tmux interpreta `#{…}`, `#(…)` y `;`;
  - `compact_window`: entero entre 50 000 y 1 000 000 (por defecto 600 000 desde el panel), que se pasa como `CLAUDE_CODE_AUTO_COMPACT_WINDOW`;
  - `resume`: añade `--continue` (solo si la máquina tiene `allow_resume`);
  - `identity`: el secreto que el servidor reservó para ese nombre (solo desde el panel; la máquina lo entrega al plugin si este apunta al mismo servidor).
- **El comando es fijo:** `claude --dangerously-load-development-channels plugin:squadra@squadra [--continue]`, lanzado por tmux sin shell. squadra-host escribe `<estado>/launch.json` con el rol y el coordinador (y, si el servidor reservó el nombre, `identity.json`), siempre con un fichero temporal y `rename`, nunca a través de un enlace simbólico; a la sesión le pasa `SQUADRA_NAME`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` si se eligió y `SQUADRA_PERMISSION_RELAY=off` si la máquina no permite el relay. El plugin hace el login solo, y sus instrucciones MCP le dicen a Claude su rol desde el principio.
- **Las reglas viven en la máquina** (`~/.config/squadra-host/settings.json`): `folders`, `max_sessions` (8), `allow_input` (true), `allow_resume` (false), `permission_relay` (igual que `allow_input`), `coordinators` (los únicos coordinadores aceptados) y `claude_command`. Un valor de tipo equivocado cuenta como la opción estricta, y un fichero ilegible como los ajustes más estrictos. El servidor las ve, pero no puede cambiarlas.
- **El terminal web equivale a estar delante de la máquina.** Escribir en Claude permite pedirle cualquier cosa, o usar `!` para ejecutar comandos. Por eso: HTTPS fuera de local, el token del servidor bien guardado, `allow_input: false` en las máquinas que solo se quieran mirar, y un registro en el servidor de quién mira o escribe en cada terminal. Pendiente para otra versión: firmar las teclas en el navegador con una clave emparejada con cada máquina, para que ni un servidor comprometido pueda escribir.

**Alta de una máquina:**
1. El panel pide `POST /api/hosts/enroll {name, configure_plugin}`. El servidor genera un código `XXXX-XXXX` de un solo uso, válido 15 minutos y guardado como hash, y devuelve el comando `curl … && node squadra-host.mjs enroll <url> <código>`.
2. En la máquina, `enroll` llama a `POST /host/enroll {code, info}` (público, limitado a 10 intentos por minuto e IP). Recibe `{id, secret}` (`sh_…`) y, si se marcó, la URL y el **token de alta** (nunca el de administración) para escribir `~/.claude/channels/squadra/.env` cuando aún no existe. El comando de alta comprueba antes el sha256 del programa descargado.
3. Guarda la credencial en `credentials.json` (600), crea `settings.json` sin ninguna carpeta permitida (se añaden con `folders add`), se copia a `~/.config/squadra-host/` y se conecta.
4. Instala el plugin en Claude Code si falta, con `claude plugin marketplace add roke22/Squadra#v<versión>` y `claude plugin install squadra@squadra`; lo activa si está desactivado. El origen está fijado en el código del host: el servidor nunca decide qué se instala. Se salta con `--no-plugin`, y `squadra-host plugin` lo instala o actualiza después.

**Plugin:** el host consulta `claude plugin list --json` al arrancar, cada 5 minutos y antes de abrir cada sesión. Lo informa al panel en `info.plugin` (`installed`, `enabled`, `version`), y el panel avisa en la tarjeta de la máquina si falta. Sin el plugin instalado y activo, la máquina rechaza abrir sesiones: arrancarían, pero nunca entrarían en Squadra.

**Conexión:** WebSocket propio (`server/ws.js`, RFC 6455 mínimo) en `/host/connect`. El host manda su secreto en la propia petición (subprotocolos `squadra` y `auth.<secreto>`): el servidor no acepta ningún socket sin credencial. Después se presenta con `{t:'hello', id}` (su información llega después del `welcome`), y una conexión nueva sustituye a la anterior. El terminal web del panel hace lo mismo con un ticket de un solo uso (`POST /api/terminal/ticket`, 30 s). Si se revoca, el servidor cierra con el código 4001 y el host termina.

| Servidor → host | Host → servidor |
|---|---|
| `open {req, spec}` · `kill {req, term}` | `reply {req, ok, result \| error}` |
| `attach {term, cols, rows}` · `detach` · `resize` · `refresh` | `screen {term, data}` · `out {term, data}` (base64) |
| `in {term, data}` (texto tecleado) | `exit {term}` · `info {info}` (cada vez que cambia) · `notice` |

**Terminal:** cada sesión es una sesión de tmux `sq-<nombre>` en un servidor de tmux propio (`tmux -L squadra -f /dev/null`, sin barra de estado). Su especificación se guarda en la opción `@squadra`, así se recupera si el host se reinicia. Mientras alguien la mira, el host engancha un cliente en modo control (`tmux -C`):
- `%output` trae la salida, con escapes octales;
- `send-keys -H` envía las teclas en hexadecimal;
- `refresh-client -C <cols>x<rows>` ajusta el tamaño.

Al engancharse, el host manda una captura de pantalla (`capture-pane -e` con hasta 1000 líneas de historial y la posición del cursor). La salida que llega mientras se toma la captura se guarda y se envía justo después.

**Navegador:** un único WebSocket por pestaña en `/api/terminal`, autenticado antes de aceptar la conexión con un ticket de un solo uso (`POST /api/terminal/ticket`, 30 s) como subprotocolo `auth.<ticket>`. Multiplexa todos los terminales que muestra. xterm.js 5.5 y su addon fit los sirve el propio servidor (`server/vendor/`, copiados sin cambios de npm) la primera vez que se abre un terminal. Si un navegador no da abasto (más de 4 MB pendientes), se le salta la salida hasta que se pone al día (el servidor pide entonces una pantalla nueva).

**API del panel:** `GET /api/hosts`; `POST /api/hosts/enroll`, `/api/hosts/rename {host, name}`, `/api/hosts/remove {host}` (eliminar: revoca y olvida), `/api/terminals/open {host, spec}` y `/api/terminals/kill {host, term}`. El flujo SSE emite `host` en cada cambio, y `hello` incluye `hosts`.

## Comandos de administración del servidor

Usan el token del servidor (administración):

```bash
H="Authorization: Bearer $SQUADRA_SERVER_TOKEN"
curl -s -X POST $URL/admin/listIdentities -H "$H"                  # sesiones registradas y si están conectadas
curl -s -X POST $URL/admin/listGroups -H "$H"
curl -s -X POST $URL/admin/deleteIdentity -H "$H" -d '{"name":"w1"}'
curl -s -X POST $URL/register -H "$H" -d '{"name":"w1","reset":true}' # rota el secreto de un nombre
curl -s -X POST $URL/admin/rotateJoinToken -H "$H"                  # nuevo token de alta
```

## Seguridad

Tras la auditoría de seguridad de la versión 0.0.1:

- **Credenciales:** token de administración (solo navegador), token de alta (máquinas; solo registra nombres nuevos), secreto por sesión (ligado a la URL del servidor que lo emitió; el plugin no lo envía a otro) y secreto por máquina (`sh_…`). Parámetros de las peticiones sin prototipo: `__proto__` no puede hacer aparecer `reset`.
- **El remitente de cada mensaje lo decide el servidor** a partir del secreto. Una respuesta (`reply_to`) solo puede citar un mensaje que el remitente ve. Los avisos del servidor no se pueden editar.
- **Grupos privados:** el creador es el dueño y el único que invita (`inviteToGroup`); los demás entran por su invitación.
- **Cada sesión filtra lo que recibe** con su lista de permitidos. Los ids de remitente y de grupo se validan antes de usarse en ficheros. El contenido se neutraliza para que nadie cierre la etiqueta `<channel>`.
- **Permisos:** la petición de un worker va solo a su coordinador; solo vale la respuesta directa de un destinatario a esa petición, una vez y durante 15 minutos; 5 respuestas erróneas silencian a esa sesión 10 minutos. Las del coordinador no van a nadie salvo `permissionApprovers` en su `access.json`. `SQUADRA_PERMISSION_RELAY=off` (squadra-host lo pone si `permission_relay` es falso) desactiva el relay.
- **Skills:** `access`, `configure`, `login`, `logout` y `status` llevan `disable-model-invocation` y solo escriben bajo `~/.claude/channels/squadra/`.
- **Tras compactar,** los mensajes recuperados se citan como cadenas JSON y se marcan como de otras sesiones.
- **Adjuntos de `reply`:** rutas absolutas, nunca de carpetas de credenciales ni ficheros tipo `.env`, `id_*`, `*.pem`; se leen por descriptor para evitar cambios entre comprobación y lectura. Descargas con tope de 50 MB; la bandeja se limpia a la semana.
- **Coordinador fijado:** el worker guarda en `coordinator-pin.json` la identidad de su coordinador (`squadra_identity`, aleatoria por registro en el servidor); si cambia, ignora sus mensajes y avisa. Igual con los nombres de la allowlist y de los grupos (`allow-pins.json`, se fijan en su primer mensaje; `/squadra:access unpin` para aceptar uno registrado de nuevo) y con los aprobadores de un coordinador.
- **Observación:** eventos con lista blanca de campos y tipos por clase (el servidor descarta el resto); enmascarado ampliado; no se envía la salida de comandos o escrituras que tocan secretos; límite de 120 llamadas y 3000 eventos por minuto y sesión.
- **Panel:** CSP estricta con el hash del script, sin iframes, sin scripts de terceros; números siempre convertidos y escapados.
- **Servidor:** WebSocket sin copias cuadráticas, sin sockets antes de autenticar (la credencial va en la petición), tramas de control según la RFC, `Origin` comprobado en `/api/terminal`, ningún socket aceptado sin credencial en la propia petición (ticket de un solo uso o secreto de la máquina); cuerpos con tiempo de inactividad de 30 s; presupuesto de subida de 500 MB/hora por sesión; límites en ediciones, reacciones y grupos; avisos de compactación con enfriamiento; SSE que no lee se desconecta.
- **squadra-host:** solo HTTPS (http solo a localhost o con `--insecure`); plugin desde la etiqueta `v<versión>` y comprobando que el marketplace `squadra` es este (si estaba sin fijar o en otra versión, lo quita, lo vuelve a añadir fijado y reinstala el plugin); `claude` con ruta absoluta; sesiones lanzadas con `env -u TMUX -u TMUX_PANE`; carpetas personales enteras, del sistema y de credenciales prohibidas; aperturas en serie; carpeta comprobada tras arrancar; mensajes del servidor validados.
- **Segunda pasada:** avisos del servidor limitados a 10 por minuto y worker (y `claimSession`/`releaseSession` a 20), con enfriamiento propio para el aviso de contexto (`SQUADRA_NOTICE_COOLDOWN_MS`, 5 min); el texto de los mensajes perdidos se cita como dato. Un nombre borrado y registrado de nuevo no ve mensajes, ficheros ni invitaciones anteriores a su creación. `joinGroup` devuelve si creó el grupo, su dueño y sus miembros (el plugin lo avisa), y el último en salir lo cierra. Subidas: hace falta `Content-Length`, dos a la vez por sesión y el presupuesto cuenta las que están llegando. `/register` con el token de alta: 10 por minuto por dirección (IPv6 por /64), 60 en total y como mucho `SQUADRA_MAX_SESSIONS` (500) identidades. Los nombres que abre el panel se reservan: el servidor registra la identidad y se la pasa a la máquina (campo `identity` de la especificación), y un nombre registrado por otra sesión se rechaza. Acciones de chat de una lista fija. Pongs con contrapresión. Cabeceras reenviadas solo con `TRUST_PROXY`, y el comando de alta siempre entrecomillado. En el plugin: adjuntos solo desde la carpeta de la sesión, su bandeja de entrada o su `outbox`, sin enlaces duros ni `/proc`; `SQUADRA_STATE_DIR` solo desde el `.env` de la máquina; las peticiones de permiso pendientes se borran al salir; variantes de la etiqueta `<channel>` neutralizadas; el hook reconoce un `claude` instalado por versiones; el enmascarado recorta la entrada antes de las expresiones regulares.
- **Cuarta auditoría:** una sesión que ocupa su nombre solo responde desde su instancia, también al leer mensajes (`getUpdates` sin instancia se rechaza); las sesiones ocupadas se guardan en la base de datos y, tras reiniciar el servidor, siguen reservadas 2 minutos para su sesión. "Desconectar sesión" anula el secreto; abrir de nuevo un nombre de la máquina desde el panel le da uno nuevo. Los avisos del servidor solo llegan a un coordinador que ha escrito a ese worker. Fechas de eventos enteras y recientes; textos de las máquinas sin caracteres de control; HSTS con TLS. En el plugin: cada login escrito se confirma (sin elicitation, solo lo aprobado antes); `approved` se conserva al guardar `access.json`; `SQUADRA_NAME` validado; `launch.json` se consume al usarlo; un worker no escribe a un coordinador rechazado; rutas comparadas sin mayúsculas; bandeja de 1 GB como máximo; más secretos enmascarados y `*.tfstate`/`*.tfvars` no se adjuntan. En el panel: lo que se pinta de cada evento va recortado y en caché, la vista no pierde historial al leer hacia atrás, enlaces al propio panel como texto, sin foco automático en un terminal abierto desde fuera, vaciar el chat como acción peligrosa, y las vistas de máquinas solo enlazan sesiones de esa máquina. En squadra-host: capturas de pantalla de 1 MB como máximo, `hello` mínimo, ajustes ilegibles = los más estrictos, sin redimensionar sin `allow_input`, `tmux` y `claude` solo de carpetas tuyas o de root y fuera de las carpetas de proyectos, carpetas comprobadas hasta la raíz, y salida 0 (sin reinicio del servicio) si el servidor rechaza la máquina.
- **Quinta auditoría:** el login automático con `SQUADRA_NAME` sin `launch.json` pide confirmación; los `permissionApprovers` del coordinador solo valen confirmados en el login; el pin del coordinador se vuelve a comprobar cada minuto; `SQUADRA_URL`/`SQUADRA_SERVER_TOKEN` solo del `.env` (y el servidor aparece en la confirmación); del `.env` solo se leen claves `SQUADRA_*`; el texto de `reply`/`edit_message` se enmascara; adjuntos: nada de `.git/`, historiales ni llaveros, la carpeta personal no cuenta como carpeta de la sesión y las raíces se comparan exactas; `access.json` ilegible un momento no se pierde; ficheros de estado escritos sin seguir enlaces; las skills solo pueden escribir `access.json`, `allow-pins.json`, `approved/*` y `.env`. Servidor: `getChat` solo da presencia, cola y contexto de sesiones con las que hay relación; límite de lecturas; emoji de reacción limpio; `info` de una máquina como mucho 60 por minuto; el aviso de la máquina va junto al pie del terminal, no en su lugar. squadra-host: mensajes de más de 1 MB del servidor cierran la conexión y la espera de reconexión solo vuelve a 1 s tras una conexión estable.
- **Límites conocidos:** el servidor sigue siendo de confianza para dar instrucciones (quien lo controle puede escribir en los terminales con `allow_input` y dar tareas por el coordinador); las sesiones de una máquina comparten usuario (para aislarlas, un usuario o contenedor por máquina); no se fija el certificado TLS (las renovaciones cambian la clave).

## Mover una sesión a otra máquina

1. Cierra la sesión en la máquina vieja (`/squadra:logout`): un nombre conectado no acepta otra copia. Copia `~/.claude/channels/squadra/<nombre>/identity.json` a la máquina nueva, con el mismo `SQUADRA_URL` en su `.env` (la identidad va ligada a esa URL exacta), o rota el secreto con `/register` y `reset: true` (necesita el token de administración).
2. Para continuar la conversación de Claude, copia también su transcripción, `~/.claude/projects/<ruta-codificada>/<id>.jsonl`, y usa `claude --resume <id>`.

## Pruebas

```bash
npm test     # servidor real + plugins reales hablando MCP por stdio + squadra-host con tmux real
# sin Node local:
docker run --rm -v "$PWD:/app" -w /app node:22 sh -c 'apt-get update && apt-get install -y tmux && npm test'
```

## Limitaciones (Channels en research preview)

- **Diálogo en cada arranque:** el flag `--dangerously-load-development-channels` muestra un diálogo cada vez. Solo funciona en sesiones interactivas: no con `-p` ni con el Agent SDK.
- **Sin acuse del modelo:** Claude Code no confirma que Claude haya leído un mensaje.
  - El `offset` de `getUpdates` confirma que el plugin lo recibió.
  - La `ackReaction` (`/squadra:access set ackReaction 👀`) confirma que el plugin se lo entregó a la sesión.
- **Sin interrupción desde fuera:** un mensaje que llega con la sesión ocupada espera al siguiente turno. Para interrumpir, pulsa Esc en el terminal del worker.
- **Cambios posibles:** la sintaxis de Channels puede cambiar mientras dure la preview.

## Contexto y compactación

Claude Code compacta automáticamente cuando una sesión se acerca al límite de contexto: hacia los ~967K tokens en los modelos de 1M, o en el límite de 200K en el resto. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` permite fijar un punto anterior. Nadie puede lanzar `/compact` desde fuera: ni Claude, ni un mensaje de channel, ni un hook. Por eso Squadra no intenta forzarlo, sino que hace que la compactación no rompa nada:

- **Reinyección.**
  - Un hook `SessionStart` con `compact`, síncrono, pide al plugin por el socket local el contexto de Squadra: nombre, rol, coordinador, reglas y los últimos 6 mensajes recibidos.
  - Lo devuelve como `additionalContext`.
  - Funciona aunque la observación esté en `off`.
- **Aviso al coordinador.**
  - El hook `PostCompact` envía el evento `compacted`, con el resumen si la observación es `full`.
  - El servidor manda un `squadra_notice` al coordinador.
  - El panel lo muestra con el resumen desplegable.
- **Porcentaje de contexto.**
  - El plugin calcula la ventana del modelo y el punto de compactación, respetando las variables de entorno, y envía `context_pct` con cada uso.
  - El servidor avisa al coordinador una sola vez al pasar del 80 %; el aviso se rearma tras compactar.
  - `ping` y el panel (indicador ámbar desde el 60 %, rojo desde el 80 %) lo muestran.
