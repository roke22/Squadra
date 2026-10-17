<p align="center"><img src="branding/squadra-logo.svg" width="96" alt="Logo de Squadra"></p>

<h1 align="center">Squadra</h1>

<p align="center"><b>Un agente coordinador que dirige escuadras de agentes de Claude Code: rápido, desatendido y a la vista en directo.</b></p>

<p align="center"><a href="README.md">Read in English</a> · v0.0.1</p>

---

Squadra le da a [Claude Code](https://claude.com/product/claude-code) un **agente coordinador** que dirige una escuadra de otros agentes de Claude Code, de forma rápida y en gran parte desatendida. Le dices al coordinador lo que quieres; él reparte el trabajo, asigna las tareas a los workers, sigue lo que hace cada uno, aprueba sus acciones seguras y solo vuelve a ti para las decisiones importantes. Está pensado para gestionar grandes equipos de agentes de forma automatizada, en una sola máquina o repartidos en varias.

Un panel web muestra toda la escuadra a la vez, como una pared de terminales: qué hace cada agente, qué herramienta está ejecutando, qué dice Claude y quién está esperando una decisión.

![Panel de Squadra: dos escuadras, cada coordinador con sus workers](docs/screenshots/mosaic-squads.jpg)

## Cómo funciona

```
                     tú
                     │  le hablas en su terminal
             ┌───────┴────────┐
             │  coordinador   │  planifica, delega, aprueba, informa
             └───────┬────────┘
                     │  mensajes a través de squadra-server
      ┌──────────────┼──────────────┬──────────────┐
 ┌────┴─────┐   ┌────┴─────┐   ┌────┴─────┐   ┌────┴─────┐
 │ worker 1 │   │ worker 2 │   │ worker 3 │   │ worker N │   cada uno una sesión de
 └──────────┘   └──────────┘   └──────────┘   └──────────┘   Claude Code, en cualquier máquina
```

- **El coordinador** es una sesión de Claude Code con el rol de coordinador. Convierte tu petición en tareas, las asigna a los workers, responde sus preguntas, aprueba las acciones inofensivas y solo te consulta lo crítico (decisiones de producto, cambios destructivos, seguridad, costes).
- **Los workers** son sesiones de Claude Code con el rol de worker, cada una en la carpeta de su proyecto. Deciden por sí mismos los detalles técnicos e informan al empezar, al terminar, si se bloquean o si necesitan una decisión.
- **`squadra-server`** (Node, sin dependencias) reparte los mensajes entre agentes, sabe quién está vivo y sirve el panel en directo. Los agentes se conectan *hacia* él, así que sus máquinas no abren puertos.
- **El plugin `squadra`** para Claude Code entrega cada mensaje directamente en la sesión del agente, aunque esté parada, mediante los [Channels](https://code.claude.com/docs/en/channels) de Claude Code, e informa al panel de lo que hace el agente.

Cada agente es un `claude` interactivo normal en un terminal, así que puedes intervenir y escribir en cualquiera en cualquier momento.

### Solo Claude, con cualquier combinación de cuentas

- **Por ahora Squadra solo es compatible con Claude Code.**
- **Cada agente usa la sesión de Claude Code de la máquina donde corre**, así que una escuadra puede mezclar agentes de la misma suscripción con agentes de suscripciones o cuentas distintas.
- **Métodos de acceso compatibles:** los que admiten los Channels de Claude Code:
  - planes de claude.ai: Pro, Max, Team y Enterprise;
  - claves de API de Anthropic Console.
- **No compatibles:** los Channels no están disponibles a través de Amazon Bedrock, Google Cloud Vertex AI ni Microsoft Foundry, así que los agentes que inicien sesión de esa forma no pueden unirse a una escuadra.

## Qué puedes hacer

- **Desarrollar una funcionalidad en varios repositorios a la vez.** Pide al coordinador «login con Google» y él da el backend, la web y la app móvil a un worker cada uno, los mantiene coordinados y te avisa cuando todo encaja.
- **Partir un trabajo grande en piezas paralelas.** Una migración, una refactorización o subir la cobertura de tests, divididas por módulo o por carpeta, con un worker por pieza y el coordinador vigilando que nadie pise a nadie.
- **Dejarlo trabajando solo.** Los workers deciden los detalles técnicos y el coordinador aprueba sus acciones seguras, así que la escuadra sigue mientras no estás. Solo esperan por ti las decisiones de producto, los cambios destructivos, la seguridad y los costes.
- **Vigilarlo desde cualquier sitio.** El panel muestra a todos los agentes en directo desde cualquier navegador. La barra «Te necesitan» te dice quién espera una respuesta, y puedes intervenir en cualquier agente, en su terminal o desde la web.
- **Aprovechar todas tus máquinas.** Los agentes pueden correr en tu portátil, en un servidor de compilación o en una máquina con GPU; cada uno se conecta hacia fuera al servidor, sin abrir puertos.
- **Combinar suscripciones.** Cada agente usa el login de Claude Code de su máquina, así que una escuadra puede repartir su trabajo entre varias cuentas.
- **Llevar varios equipos.** Varios coordinadores pueden compartir un servidor, cada uno con sus workers, y el panel los agrupa en escuadras.

## Qué ofrece

- **Coordinador y workers.**
  - El coordinador delega con `reply`; los workers informan al empezar, al terminar, si se bloquean o si necesitan una decisión.
  - El coordinador solo responde cuando tiene algo que decir, así que nunca se forman bucles de acuses de recibo.
- **Cada decisión en su sitio.** Los workers deciden los detalles técnicos y preguntan lo de producto o lo destructivo; el coordinador responde o te lo pregunta a ti.
- **Permisos retransmitidos.** La petición de permiso de un worker llega también al coordinador, que aprueba lo inofensivo y te pregunta el resto. Vale la primera respuesta, así que también puedes contestar en el terminal del worker.
- **Entrega según el rol.**
  - Un mensaje a un worker desconectado se rechaza en el momento, para que una tarea nunca espere a una sesión que quizá no vuelva.
  - Los mensajes al coordinador se guardan hasta que vuelve.
- **Presencia.**
  - `ping` dice si una sesión está viva sin despertarla.
  - El coordinador recibe un aviso cuando un worker sale, se cierra o se cae, junto con el trabajo que no llegó a recoger.
- **Contexto que sobrevive a la compactación.**
  - Cuando un agente se autocompacta, Squadra le devuelve su rol, su coordinador y los últimos mensajes que recibió, para que siga con la misma tarea.
  - El coordinador recibe un aviso cuando un worker compacta, y otro, uno solo, cuando un worker pasa del 80 % de su contexto.
  - `ping` y el panel muestran cuánto contexto lleva usado cada agente antes de autocompactar.
- **Control de acceso:**
  - códigos de emparejamiento y listas de permitidos;
  - grupos con @menciones;
  - el servidor autentica a cada remitente.
- **Panel en directo.**
  - **Mosaico de chats en directo:** tantas columnas como quepan en tu pantalla, con colores por rol.
  - **Vista de chat por sesión:** markdown, herramientas agrupadas con su entrada y su salida, scroll infinito, y acciones para limpiar, archivar o eliminar una sesión.
  - **Escuadras:** cada coordinador en un recuadro de la barra lateral, con sus workers plegados debajo (👥 2/3 conectados), y un mosaico por escuadra.
  - **Barra «Te necesitan»:** los permisos pendientes de respuesta y los contextos a punto de compactarse, de todas las sesiones.
  - En español e inglés.
- **Sesiones abiertas desde el panel.**
  - Añade una máquina con un comando, generado por el panel, que instala y da de alta `squadra-host` en ella.
  - Abre allí coordinadores y workers desde el navegador y usa sus terminales en directo: ves a Claude, le escribes, aceptas sus diálogos e incluso haces `/login` con la suscripción de esa máquina.
  - La máquina solo acepta una *especificación* de sesión (nombre, rol, una carpeta permitida y la ventana de autocompactación), nunca un comando; sus límites viven en la propia máquina.
  - Las sesiones solo las abres tú, nunca Claude: si un coordinador necesita más workers, te los pide.

## Galería

Así se ve el panel. Pulsa cualquier imagen para verla a tamaño completo.

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/squad-view.jpg"><img src="docs/screenshots/squad-view.jpg" alt="Una escuadra cada vez"></a><br><b>Una escuadra cada vez</b><br>▦ junto a un coordinador muestra solo su escuadra, con un botón para añadirle un worker.</td><td width="50%" valign="top"><a href="docs/screenshots/session-view.jpg"><img src="docs/screenshots/session-view.jpg" alt="Una sesión como un chat"></a><br><b>Una sesión como un chat</b><br>El texto de Claude con markdown, las herramientas agrupadas con su entrada y su salida, y los mensajes que envía y recibe.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/machines.jpg"><img src="docs/screenshots/machines.jpg" alt="Las máquinas y sus sesiones"></a><br><b>Las máquinas y sus sesiones</b><br>Cada ordenador con squadra-host, sus carpetas permitidas y las sesiones abiertas en él: abre su terminal o su chat, o ciérralas.</td><td width="50%" valign="top"><a href="docs/screenshots/web-terminal.jpg"><img src="docs/screenshots/web-terminal.jpg" alt="Terminal web en directo"></a><br><b>Terminal web en directo</b><br>Ves Claude Code tal cual en su terminal y le escribes: aceptas sus diálogos, haces /login o /model, le das instrucciones.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/add-machine.jpg"><img src="docs/screenshots/add-machine.jpg" alt="Añadir una máquina con un comando"></a><br><b>Añadir una máquina con un comando</b><br>Un código de un solo uso, válido 15 minutos. La máquina aparece conectada en cuanto se ejecuta el comando.</td><td width="50%" valign="top"><a href="docs/screenshots/new-session.jpg"><img src="docs/screenshots/new-session.jpg" alt="Abrir una sesión desde el navegador"></a><br><b>Abrir una sesión desde el navegador</b><br>Máquina, rol, nombre, carpeta y cuándo autocompactar. Aquí, un worker nuevo para la escuadra de coord.</td></tr>
</table>

## Requisitos

- **Linux o macOS.** En Windows, usa WSL (mira [Windows (WSL)](#windows-wsl) más abajo).
- **Node.js ≥ 22.13**, en el servidor y en cada máquina donde corra una sesión de Claude con el plugin.
- **tmux ≥ 3.0**, solo en las máquinas donde abras sesiones desde el panel.
- **Claude Code** con sesión iniciada en un plan de claude.ai (Pro, Max, Team o Enterprise) o con una clave de API de Anthropic Console. Cada agente puede usar una cuenta distinta.
- **En Team/Enterprise**, un Owner tiene que activar *Channels* en la configuración de la organización.

### macOS

Todo funciona igual que en Linux:

```bash
brew install node@22 tmux        # tmux solo donde abras sesiones desde el panel
```

- Añade el alias `claude-squadra` (paso 3, más abajo) a `~/.zshrc`, el shell por defecto de macOS.
- `squadra-host service` imprime un agente de **launchd** (`~/Library/LaunchAgents/com.squadra.host.plist`) en lugar de un servicio de systemd, con los comandos para cargarlo. Funciona mientras tengas la sesión iniciada, porque Claude Code guarda su login en el Llavero.

### Windows (WSL)

Squadra no funciona en Windows nativo: el plugin y squadra-host se niegan a arrancar allí y te remiten a WSL. Ejecuta Claude Code y Squadra dentro de **WSL**, el Linux que trae Windows, y todo funciona igual que en Linux:

1. **Instala WSL con Ubuntu.** En PowerShell como administrador: `wsl --install -d Ubuntu`, reinicia y abre *Ubuntu* desde el menú Inicio.
2. **Dentro de Ubuntu, instala Node 22, tmux y Claude Code:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs tmux
   curl -fsSL https://claude.ai/install.sh | bash
   ```
3. **Sigue la [puesta en marcha](#puesta-en-marcha) dentro de Ubuntu.** El panel se abre en tu navegador de Windows en `http://localhost:7787`, porque WSL reenvía `localhost` a Windows.

- **Guarda los proyectos en el sistema de ficheros de Linux** (`~/projects`), no en `/mnt/c/…`: las herramientas de Claude van mucho más rápido.
- **WSL se detiene cuando Windows lo ve inactivo**, por ejemplo al cerrar todas las terminales de Ubuntu. Deja una abierta mientras trabaja la escuadra, o consulta en la documentación de Microsoft cómo mantener WSL en marcha.
- **Para tener squadra-host siempre en segundo plano,** activa systemd en WSL (`[boot]` `systemd=true` en `/etc/wsl.conf`; las imágenes recientes de Ubuntu ya lo traen) y usa el servicio de systemd que imprime `squadra-host service`.


## Puesta en marcha

### 1. Arrancar el servidor

```bash
git clone https://github.com/roke22/Squadra.git squadra && cd squadra
node server/server.js
```

La primera vez genera dos tokens y muestra los dos: el **token del servidor** (administración, `data/server-token`), para entrar en el panel, y el **token de alta** (`data/join-token`), con el que las máquinas registran sus sesiones, dentro de un comando `/squadra:configure` listo para copiar. Escucha en `http://127.0.0.1:7787`.

- **Con Docker:**
  ```bash
  docker build -f server/Dockerfile -t squadra-server .
  docker run -d --name squadra-server -p 7787:7787 -v squadra-data:/data squadra-server
  docker logs squadra-server   # muestra los tokens
  ```
- **Opciones** (parámetro, o la variable de entorno entre paréntesis):

  | Parámetro | |
  |---|---|
  | `--host <ip>` (`HOST`) | Interfaz en la que escucha. Por defecto `127.0.0.1`: solo esta máquina |
  | `--all-interfaces` | Escucha en todas las IPs de la máquina (igual que `--host 0.0.0.0`) |
  | `--port <n>` (`PORT`) | Por defecto `7787` |
  | `--public-url <url>` (`PUBLIC_URL`) | La dirección que usan los agentes y el navegador, por ejemplo `https://squadra.example.com`; aparece en el comando de configuración |
  | `--data-dir <ruta>` (`DATA_DIR`) | Base de datos y ficheros. Por defecto `./data` |
  | `--domain <nombre>` (`SQUADRA_DOMAIN`) | HTTPS integrado con certificado automático de Let's Encrypt (ver abajo) |
  | `--tls-cert <fichero>` `--tls-key <fichero>` | HTTPS con tu propio certificado; se recarga si cambian los ficheros |
  | `--trust-proxy` (`TRUST_PROXY=1`) | Detrás de un proxy inverso que pone `X-Forwarded-For`: los límites de frecuencia usan la dirección del cliente |

  `node server/server.js --help` muestra todas las opciones.

### Publicarlo con un dominio (HTTPS)

Las sesiones de otras máquinas tienen que poder llegar al servidor. **No lo expongas en HTTP sin cifrar:** el token del servidor, los secretos de las sesiones y todo lo que muestra el panel viajarían en claro, y el servidor avisa si lo intentas.

**HTTPS integrado (lo más sencillo):** dale al servidor tu dominio y él mismo obtiene un certificado de Let's Encrypt, lo renueva antes de que caduque y redirige el HTTP a HTTPS. No hay que instalar nada más.

1. Apunta el registro DNS de tu dominio a la máquina.
2. Asegúrate de que los puertos **80** (validación del certificado) y **443** son accesibles desde internet.
3. Arráncalo:
   ```bash
   node server/server.js --domain squadra.example.com --acme-email tu@example.com
   # o con Docker:
   docker run -d --name squadra-server -p 80:80 -p 443:443 -v squadra-data:/data \
     -e SQUADRA_DOMAIN=squadra.example.com squadra-server
   ```
   Muestra `/squadra:configure https://squadra.example.com <token-de-alta>`, y el panel queda en `https://squadra.example.com/`.

- **Puertos privilegiados fuera de Docker (Linux):** los puertos 80 y 443 necesitan privilegios. Ejecútalo como root, o da permiso a Node una sola vez con `sudo setcap cap_net_bind_service=+ep $(command -v node)`.
- **Para probar:** `--acme-staging` usa el entorno de pruebas de Let's Encrypt, que emite certificados no confiables pero tiene límites más amplios.

**Tu propio certificado:** `--tls-cert fullchain.pem --tls-key privkey.pem --public-url https://squadra.example.com`. El servidor recarga los ficheros cuando cambian, por ejemplo tras una renovación de certbot.

**Detrás de un proxy inverso:** si ya tienes uno, deja el servidor en `127.0.0.1` y apunta el proxy hacia él. En [`deploy/`](deploy/) hay un Docker Compose listo con Caddy.

**Red privada:** en algo como Tailscale puedes prescindir de TLS con `--all-interfaces`.

Las sesiones siempre se conectan *hacia* el servidor, así que sus máquinas no abren puertos.

### 2. Instalar el plugin (una vez por máquina)

En cada máquina donde vaya a correr un coordinador o un worker. Dentro de `claude`:

```
/plugin marketplace add roke22/Squadra
/plugin install squadra@squadra
```

O desde el terminal (útil en servidores, en WSL o en scripts):

```bash
claude plugin marketplace add roke22/Squadra
claude plugin install squadra@squadra
```

Después apúntalo a tu servidor, con el comando que el servidor mostró al arrancar:

```
/squadra:configure https://squadra.example.com <token-de-alta>
```

- **Usa la dirección con la que las demás máquinas llegan** al servidor: `http://127.0.0.1:7787` solo funciona en la propia máquina del servidor.
- **Vuelve a arrancar Claude Code después.** El plugin lee su configuración al empezar la sesión y, de todas formas, el channel de Squadra se activa al arrancar (siguiente paso).
- **Las máquinas añadidas desde el panel** instalan y configuran el plugin solas al darlas de alta.
- **Claude Code ejecuta el plugin con `node`,** así que Node 22 tiene que estar en el `PATH` que ve Claude Code.
- Para usar una copia local de este repositorio, pasa su ruta a `marketplace add`.

**Actualizar:** `claude plugin marketplace update squadra && claude plugin update squadra@squadra`, y reinicia las sesiones.

### 3. Arrancar las sesiones y hacer login

Los channels solo se pueden activar al arrancar Claude Code, así que crea un alias una vez:

```bash
alias claude-squadra='claude --dangerously-load-development-channels plugin:squadra@squadra'
```

Ponlo en `~/.bashrc`, o en `~/.zshrc` en macOS.

> Mientras Channels esté en *research preview*, este flag muestra un diálogo de confirmación en cada arranque. Elige **"I am using this for local development"**.

Después, en cada terminal:

| Comando | |
|---|---|
| `/squadra:login coordinador` | Entra como coordinador (con el nombre `coord`) |
| `/squadra:login worker1` | Entra como worker; saluda al coordinador automáticamente |
| `/squadra:status` | Quién eres, emparejamientos pendientes y qué sesiones están vivas |
| `/squadra:logout` | Sale |
| `/squadra:access pair <código>` | Aprueba a un worker, en el terminal del coordinador |

La primera vez que entra un worker, el coordinador muestra una petición de emparejamiento: apruébala con `/squadra:access pair <código>`. A partir de ahí, ese nombre entra sin preguntar.

### 4. Abrir el panel

Abre la dirección del servidor (`http://127.0.0.1:7787/`) y entra con el token del servidor (el de administración).

<p align="center"><img src="docs/screenshots/sign-in.jpg" width="560" alt="Pantalla de acceso al panel"></p>

### O bien: abrir las sesiones desde el panel

En lugar de arrancar `claude` a mano en cada terminal, deja que el panel lo haga en máquinas con **squadra-host**:

1. **Añade la máquina.** En **🖥️ Máquinas → + Añadir máquina**, el panel te da un comando de un solo uso (válido 15 minutos). Ejecútalo en la máquina, en la carpeta donde se podrán abrir sesiones:

   ```bash
   curl -fsSLo squadra-host.mjs https://squadra.example.com/host/squadra-host.mjs \
     && echo "<sha256>  squadra-host.mjs" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -) \
     && node squadra-host.mjs enroll https://squadra.example.com ABCD-2345
   ```

   Comprueba el programa descargado, cambia el código por una credencial propia de la máquina, permite la carpeta actual (salvo que sea tu carpeta personal entera o una del sistema), **instala el plugin de Squadra en Claude Code** y lo apunta a este servidor si aún no lo están, y aparece como conectada. La máquina necesita tener Claude Code instalado antes; añade `--no-plugin` para saltarte el plugin. Para que siga funcionando, `node ~/.config/squadra-host/squadra-host.mjs service` imprime un servicio de systemd en Linux o un agente de launchd en macOS.
2. **Abre una sesión.** **+ Nueva sesión**: máquina, rol, nombre, carpeta (una de las permitidas en la máquina, más una subcarpeta opcional), cuándo autocompactar (600K tokens por defecto, lo recomendado para modelos de 1M de contexto) y si continuar la última conversación. Arranca `claude` con el channel de Squadra dentro de tmux y hace el login sola.
3. **Usa su terminal.** La sesión se abre en un terminal web en directo. En el primer arranque acepta el aviso de channels de desarrollo y, si lo pide, confía en la carpeta y haz `/login`. Desde ese momento puedes verla o escribirle desde cualquier navegador; el chat y el mosaico siguen funcionando igual.

En la máquina:

| Comando | |
|---|---|
| `node squadra-host.mjs folders add <ruta>` | Permitir sesiones en otra carpeta (también `folders remove` y `folders`) |
| `node squadra-host.mjs status` | Ajustes y sesiones abiertas |
| `node squadra-host.mjs plugin` | Instalar el plugin de Squadra, o actualizarlo (después reinicia las sesiones abiertas) |
| `tmux -L squadra attach -t sq-<nombre>` | Engancharse a una sesión en local |

Las reglas de la máquina están en `~/.config/squadra-host/settings.json` (solo la propia máquina puede cambiarlas):

| Ajuste | |
|---|---|
| `folders` | Dónde se pueden abrir sesiones, y todo lo que hay dentro. Nunca una carpeta personal entera o del sistema, ni donde viven credenciales |
| `max_sessions` | Como mucho estas sesiones a la vez (8) |
| `allow_input` | Si el panel puede escribir en los terminales (`true`). Ponlo a `false` para solo mirar |
| `permission_relay` | Si el coordinador de un worker puede responder a sus peticiones de permiso desde otra sesión (por defecto, igual que `allow_input`) |
| `coordinators` | Si se indica, los únicos nombres de coordinador que pueden tener los workers de esta máquina |
| `claude_command` | El ejecutable de Claude Code (`claude`, buscado solo en las entradas absolutas del `PATH`) |

La máquina se conecta solo por HTTPS: `http` sin cifrar solo se acepta para `localhost`, o con `--insecure` en el alta, en una red privada de confianza. **Desconectar**, en el menú ⋯ de la máquina, revoca su credencial.

## Consejos: cómo sacarle el máximo partido

### Haz de tu coordinador un repositorio de Git

El coordinador es una sesión de Claude Code como cualquier otra, así que **todo lo que define cómo se comporta Claude Code en una carpeta define a tu coordinador**: `CLAUDE.md`, skills, subagentes, ajustes y servidores MCP. Ponlo todo en un repositorio propio y abre el coordinador en él. Así:

- **Todos los coordinadores se comportan igual.** Clona el repositorio en cualquier máquina, o abre allí el coordinador desde el panel, y tendrás la misma forma de planificar, las mismas reglas y la misma forma de informar.
- **Su comportamiento queda versionado.** Cambias cómo trabaja el coordinador con commits y pull requests, los revisas como código y vuelves atrás si algo empeora.
- **Tu equipo lo comparte.** Todos usan el mismo coordinador, con vuestras convenciones incluidas.
- **Puedes tener varios tipos.** Un repositorio por función: un `release-manager`, un `web-lead`, un `security-reviewer`…

Una estructura típica:

```
mi-coordinador/
├── CLAUDE.md               cómo planifica, reparte e informa, y qué debe preguntarte
├── .claude/
│   ├── settings.json       modelo, permisos que puede usar sin preguntar, hooks
│   ├── skills/
│   │   ├── release/SKILL.md     «sacar una versión»: los pasos que reparte a los workers
│   │   └── triage/SKILL.md      «clasificar las issues nuevas»: cómo las reparte
│   └── agents/             subagentes para su propio análisis (p. ej. un planificador)
├── .mcp.json               herramientas que necesita: tu gestor de issues, documentación, CI
└── docs/                   notas de arquitectura, glosario, convenciones del equipo
```

Lo que suele funcionar bien en su `CLAUDE.md`:

```markdown
# Coordinador del equipo de la tienda

- Repositorios: shop-api (worker «api»), shop-web (worker «web»), shop-mobile (worker «mobile»).
- Da a cada worker tareas solo de su repositorio. Una tarea por worker cada vez.
- Toda tarea tiene una definición de terminado: tests en verde, lint limpio, rama task/<tema>.
- Nunca apruebes merges a main, despliegues ni cambios en la base de datos de producción: pregúntame.
- Al terminar una tarea, dame un resumen de tres líneas: qué cambió, dónde y qué queda.
```

Las reglas de Squadra para cada rol (cómo enviar mensajes, cuándo responder, qué escalar) vienen del plugin. Tu `CLAUDE.md` añade encima las reglas de tu equipo.

### Deja el conocimiento de cada proyecto en el proyecto

Los workers se abren en la carpeta de su proyecto, así que leen el `CLAUDE.md` **de ese proyecto**: cómo compilarlo, probarlo y organizar el código. Un reparto útil:

- **El repositorio del coordinador** recoge cómo trabaja el equipo: quién hace qué, reglas, prioridades y qué necesita tu aprobación.
- **El repositorio de cada proyecto** recoge cómo funciona ese código.

Así un worker se comporta bien en su repositorio sea quien sea su coordinador.

### Más consejos

- **Pon a los workers nombres de lo que hacen** (`api`, `web`, `docs`, no `worker3`). El coordinador lee los nombres al decidir a quién da cada tarea.
- **Un worker por repositorio o por área.** Dos agentes editando los mismos ficheros se estorban. Para trabajar en paralelo en un mismo repositorio, da a cada worker su propio [git worktree](https://git-scm.com/docs/git-worktree).
- **Deja margen de contexto.** Con modelos de 1M de contexto, autocompactar a los 600K (lo que propone el panel por defecto) mantiene a los agentes finos. El coordinador ve el contexto usado por cada worker y da las tareas grandes a los que tienen margen.
- **Usa grupos para los avisos.** Un `#grupo` llega a varios workers a la vez, por ejemplo «congelado: no se integra nada hasta que salga la versión».
- **Pon el coordinador en una máquina siempre encendida.** Los mensajes al coordinador le esperan, pero un coordinador en un servidor que nunca se apaga mantiene la escuadra en marcha de noche.
- **Reduce lo que ve el panel en código sensible.** `--observe activity` envía solo qué herramientas usa un agente, con argumentos cortos: ni el texto de Claude ni las salidas.
- **Máquinas de solo lectura.** Pon `allow_input: false` en los ajustes de squadra-host de una máquina cuando quieras ver sus sesiones pero no escribir en ellas desde la web.

## Qué puede hacer Claude

| Herramienta | |
|---|---|
| `reply(chat_id, text, reply_to?, files?)` | Escribe a una sesión o a un `#grupo`, con adjuntos si hace falta |
| `edit_message` | Actualiza un mensaje anterior (progreso) |
| `react` | Reacciona con un emoji; nunca despierta al otro lado |
| `download_attachment` | Descarga un adjunto a la bandeja local |
| `ping(chat_id?)` | ¿Está viva una sesión? Responde el servidor, no la sesión |
| `login` · `logout` · `status` | Las usan los comandos `/squadra:*` |

## Seguridad

- **Tres tipos de credenciales:**
  - el **token del servidor** (administración) da acceso al panel, abre terminales web y ejecuta `/admin/*`. Su sitio es tu navegador y ningún otro;
  - el **token de alta** (`sj_…`) es el que guardan las máquinas: solo registra nombres de sesión *nuevos*. No abre terminales, no lee el panel ni se queda con un nombre existente;
  - cada nombre de sesión tiene su propio **secreto**, ligado al servidor que lo emitió, así que ninguna sesión puede hacerse pasar por otra.
  - Rota el token de alta con `curl -X POST <url>/admin/rotateJoinToken -H "Authorization: Bearer <token-del-servidor>"` (las sesiones existentes siguen funcionando). Para cambiar el token del servidor, define `SQUADRA_SERVER_TOKEN`, o borra `data/server-token` y reinicia.
- **Los mensajes de otras sesiones son contexto de trabajo, nunca tu autorización.** Las skills `/squadra:access`, `/squadra:configure`, `/squadra:login` y `/squadra:logout` solo las puedes lanzar tú, no Claude, y solo editan los ficheros de Squadra.
- **Peticiones de permiso:** la de un worker solo va a su coordinador, y solo cuenta la respuesta directa de ese coordinador a esa misma petición (una vez, durante 15 minutos). Las del coordinador no van a nadie salvo que indiques aprobadores en su `access.json` (`permissionApprovers`). Las respuestas erróneas repetidas de una sesión se ignoran.
- **Los grupos son privados:** quien crea un `#grupo` es su dueño; los demás solo entran si un miembro los invita.
- **Los adjuntos de `reply`** tienen que ser rutas absolutas dentro de la carpeta de la sesión, su bandeja o la carpeta temporal, y nunca credenciales (`.env`, `id_*`, `*.pem`, nada de `~/.ssh`, `~/.aws`, `~/.claude`…), enlaces duros ni ficheros del sistema.
- **Los nombres que abre el panel quedan reservados** para la máquina que los abre: nadie con el token de alta puede registrarlos antes. El registro con el token de alta tiene límite de frecuencia, y el servidor admite como mucho `SQUADRA_MAX_SESSIONS` (500) sesiones.
- **El coordinador queda fijado:** un worker recuerda la identidad del coordinador con el que habló por primera vez; si ese nombre lo registra después otra persona, lo ignora y te avisa.
- **El panel puede recibir código y salidas de comandos** (nivel de observación `full`). Usa TLS si el servidor no es local, o baja el nivel por sesión con `--observe activity` u `off`. Los secretos reconocibles (claves de API, `*_TOKEN=`, `*_PASSWORD=`, claves privadas, contraseñas en URLs) se enmascaran, y la salida de comandos o escrituras que tocan `.env`, claves o credenciales no se envía.
- **La página del panel** funciona con una Content-Security-Policy estricta, no se puede meter en un iframe y no carga scripts de terceros (xterm.js lo sirve el propio servidor).
- **Máquinas con squadra-host:**
  - nunca ejecutan lo que manda el servidor: solo una especificación de sesión, validada contra sus ajustes locales, con un comando fijo;
  - hablan con el servidor solo por HTTPS (http sin cifrar solo a `localhost`, o con `--insecure` en una red de confianza); el comando de alta comprueba el sha256 del programa, y el plugin se instala desde una versión etiquetada;
  - no se pueden abrir sesiones en una carpeta personal entera o del sistema, ni donde viven credenciales;
  - **el servidor sigue siendo de confianza para dar instrucciones:** quien lo controle (o controle el panel) puede escribir en los terminales con `allow_input` activado, y dar tareas a los workers a través de su coordinador. En las máquinas que solo quieras mirar, pon `allow_input: false` (también desactiva las respuestas remotas a permisos) y fija `coordinators`;
  - **las sesiones de una máquina corren con el mismo usuario.** squadra-host les oculta tmux, pero una sesión que quiera todavía puede llegar a las demás o a tus ficheros. Para aislarlas de verdad, ejecuta squadra-host de cada máquina con un usuario propio (o en un contenedor o una VM).

## Estado y limitaciones

- **Versión 0.0.1:** temprana, pero cubierta por pruebas de punta a punta: `npm test` arranca un servidor real, procesos reales del plugin hablando MCP y squadra-host con un tmux real. El flujo de GitHub Actions las ejecuta en Linux y en macOS.
- **Linux y macOS.** Windows, a través de WSL.
- **Se apoya en los [Channels](https://code.claude.com/docs/en/channels) de Claude Code, que están en *research preview*:**
  - los channels propios necesitan el flag de desarrollo y su diálogo en cada arranque;
  - solo funcionan en sesiones interactivas, no con `-p` ni con el Agent SDK.
- **Un mensaje a una sesión ocupada espera a su siguiente turno.** Para interrumpir a un worker, pulsa Esc en su terminal.

## Estructura del repositorio

```
server/            squadra-server y el panel (ui.html; vendor/ trae xterm.js)
deploy/            Docker Compose opcional con Caddy delante
plugins/squadra/   el plugin de Claude Code: servidor MCP de channel, hooks, skills
host/              squadra-host: abre sesiones en una máquina para el panel
.github/           CI: las pruebas en Linux y macOS
.claude-plugin/    manifiesto del marketplace
branding/          ficheros del logo
test/              pruebas de punta a punta
PLAN.md            guía técnica completa
```

## Licencia

[MIT](LICENSE): puedes usarlo, copiarlo, modificarlo y distribuirlo libremente, para cualquier fin.
