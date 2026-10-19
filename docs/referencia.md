<p align="center"><img src="../branding/squadra-logo.svg" width="96" alt="Logo de Squadra"></p>

<h1 align="center">Squadra</h1>

<p align="center"><b>Un agente coordinador que dirige escuadras de agentes de Claude Code: rápido, desatendido y a la vista en directo.</b></p>

<p align="center"><a href="reference.md">Read in English</a> · v0.0.3</p>

---

> Esta es la referencia completa: instalación manual, todas las opciones y los detalles técnicos. Para empezar basta con el [README](../README-es.md).


Squadra le da a [Claude Code](https://claude.com/product/claude-code) un **agente coordinador** que dirige una escuadra de otros agentes de Claude Code, de forma rápida y en gran parte desatendida. Le dices al coordinador lo que quieres; él reparte el trabajo, asigna las tareas a los workers, sigue lo que hace cada uno, aprueba sus acciones seguras y solo vuelve a ti para las decisiones importantes. Está pensado para gestionar grandes equipos de agentes de forma automatizada, en una sola máquina o repartidos en varias.

Un panel web muestra toda la escuadra a la vez, como una pared de terminales: qué hace cada agente, qué herramienta está ejecutando, qué dice Claude y quién está esperando una decisión.

![Panel de Squadra: dos escuadras, cada coordinador con sus workers](screenshots/mosaic-squads.jpg)

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
  - Los mensajes al coordinador se guardan hasta que vuelve (hasta 24 h; como mucho 500 por remitente y 10 000 en total, descartando primero los más antiguos).
- **Presencia.**
  - `ping` dice si está viva, sin despertarla, una sesión con la que ya has intercambiado mensajes (o compartes grupo); de las demás no muestra presencia.
  - El coordinador recibe un aviso cuando un worker sale, se cierra o se cae, junto con el trabajo que no llegó a recoger (una vez que el coordinador le ha escrito a ese worker).
- **Contexto que sobrevive a la compactación.**
  - Cuando un agente se autocompacta, Squadra le devuelve su rol, su coordinador y los últimos mensajes que recibió, para que siga con la misma tarea.
  - El coordinador recibe un aviso cuando un worker compacta, y otro, uno solo, cuando un worker pasa del 80 % de su contexto (una vez que el coordinador le ha escrito a ese worker).
  - `ping` y el panel muestran cuánto contexto lleva usado cada agente antes de autocompactar (no en sesiones con observación `off`, que tampoco envían avisos del 80 % ni de compactación).
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
<tr><td width="50%" valign="top"><a href="screenshots/squad-view.jpg"><img src="screenshots/squad-view.jpg" alt="Una escuadra cada vez"></a><br><b>Una escuadra cada vez</b><br>▦ junto a un coordinador muestra solo su escuadra, con un botón para añadirle un worker.</td><td width="50%" valign="top"><a href="screenshots/session-view.jpg"><img src="screenshots/session-view.jpg" alt="Una sesión como un chat"></a><br><b>Una sesión como un chat</b><br>El texto de Claude con markdown, las herramientas agrupadas con su entrada y su salida, y los mensajes que envía y recibe.</td></tr>
<tr><td width="50%" valign="top"><a href="screenshots/machines.jpg"><img src="screenshots/machines.jpg" alt="Las máquinas y sus sesiones"></a><br><b>Las máquinas y sus sesiones</b><br>Cada ordenador con squadra-host, sus carpetas permitidas y las sesiones abiertas en él: abre su terminal o su chat, o ciérralas.</td><td width="50%" valign="top"><a href="screenshots/web-terminal.jpg"><img src="screenshots/web-terminal.jpg" alt="Terminal web en directo"></a><br><b>Terminal web en directo</b><br>Ves Claude Code tal cual en su terminal y le escribes: aceptas sus diálogos, haces /login o /model, le das instrucciones.</td></tr>
<tr><td width="50%" valign="top"><a href="screenshots/add-machine.jpg"><img src="screenshots/add-machine.jpg" alt="Añadir una máquina con un comando"></a><br><b>Añadir una máquina con un comando</b><br>Un código de un solo uso, válido 15 minutos. La máquina aparece conectada en cuanto se ejecuta el comando.</td><td width="50%" valign="top"><a href="screenshots/new-session.jpg"><img src="screenshots/new-session.jpg" alt="Abrir una sesión desde el navegador"></a><br><b>Abrir una sesión desde el navegador</b><br>Máquina, rol, nombre, carpeta y cuándo autocompactar. Aquí, un worker nuevo para la escuadra de coord.</td></tr>
</table>

## Requisitos

- **Linux o macOS.** En Windows, usa WSL (mira [Windows (WSL)](#windows-wsl) más abajo).
- **Node.js ≥ 22.13**, en el servidor y en cada máquina donde corra una sesión de Claude con el plugin.
- **tmux ≥ 3.2**, solo en las máquinas donde abras sesiones desde el panel.
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

Squadra no funciona en Windows nativo: squadra-host se niega a arrancar y el plugin a hacer login; los dos te remiten a WSL. Ejecuta Claude Code y Squadra dentro de **WSL**, el Linux que trae Windows, y todo funciona igual que en Linux:

1. **Instala WSL con Ubuntu.** En PowerShell como administrador: `wsl --install -d Ubuntu`, reinicia y abre *Ubuntu* desde el menú Inicio.
2. **Dentro de Ubuntu, instala Node 22, tmux y Claude Code:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs tmux
   curl -fsSL https://claude.ai/install.sh | bash
   ```
3. **Sigue la [puesta en marcha](#puesta-en-marcha) dentro de Ubuntu.** El panel se abre en tu navegador de Windows en `http://localhost:7787`, porque WSL reenvía `localhost` a Windows.

- **Guarda los proyectos en el sistema de ficheros de Linux** (`~/projects`), no en `/mnt/c/…`: las herramientas de Claude van mucho más rápido, y squadra-host rechaza las carpetas de `/mnt/c` (las unidades de Windows aparecen como escribibles por cualquiera).
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
  docker run -d --name squadra-server -p 127.0.0.1:7787:7787 -e PUBLIC_URL=http://127.0.0.1:7787 -v squadra-data:/data squadra-server   # solo esta máquina; para otras máquinas usa HTTPS (abajo)
  docker logs squadra-server   # muestra los tokens
  ```
- **Opciones** (parámetro, o la variable de entorno entre paréntesis):

  | Parámetro | |
  |---|---|
  | `--host <ip>` (`HOST`) | Interfaz en la que escucha. Por defecto `127.0.0.1`: solo esta máquina (con `--domain` o `--tls-cert`: todas las interfaces) |
  | `--all-interfaces` | Escucha en todas las IPs de la máquina (igual que `--host 0.0.0.0`) |
  | `--port <n>` (`PORT`) | Por defecto `7787` (con `--domain` o `--tls-cert`: `443`; `--domain` usa además el `80`, `--http-port`) |
  | `--public-url <url>` (`PUBLIC_URL`) | La dirección que usan los agentes y el navegador, por ejemplo `https://squadra.example.com`; aparece en el comando de configuración |
  | `--data-dir <ruta>` (`DATA_DIR`) | Base de datos y ficheros. Por defecto `./data` |
  | `--domain <nombre>` (`SQUADRA_DOMAIN`) | HTTPS integrado con certificado automático de Let's Encrypt (ver abajo) |
  | `--tls-cert <fichero>` `--tls-key <fichero>` | HTTPS con tu propio certificado; se recarga si cambian los ficheros |
  | `--trust-proxy` (`TRUST_PROXY=1`) | Detrás de un proxy inverso (o túnel) que pone `X-Forwarded-For`: los límites de frecuencia usan la dirección del cliente. Sin esto, todos los clientes de detrás comparten una dirección, y una dirección tiene como mucho 256 conexiones abiertas |

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

**Detrás de un proxy inverso:** si ya tienes uno, deja el servidor en `127.0.0.1`, apunta el proxy hacia él y arráncalo con `--public-url https://tu-dominio --trust-proxy` (sin ellos, los comandos que da a las máquinas usan http sin cifrar, que estas rechazan). En [`deploy/`](../deploy/) hay un Docker Compose listo con Caddy.

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
- **Las máquinas añadidas desde el panel** instalan y configuran el plugin solas al darlas de alta (con la dirección del servidor; el token de alta solo si marcas esa opción).
- **Claude Code ejecuta el plugin con `node`,** así que Node 22.13 o posterior tiene que estar en el `PATH` que ve Claude Code.
- Para usar una copia local de este repositorio, pasa su ruta a `marketplace add` (no en máquinas con squadra-host, que solo aceptan el marketplace roke22/Squadra).

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

La primera vez que entra un worker, el coordinador muestra una petición de emparejamiento: apruébala con `/squadra:access pair <código>`. A partir de ahí, ese nombre no necesita emparejarse de nuevo.

### 4. Abrir el panel

Abre la dirección del servidor (`http://127.0.0.1:7787/`) y entra con el token del servidor (el de administración).

<p align="center"><img src="screenshots/sign-in.jpg" width="560" alt="Pantalla de acceso al panel"></p>

### O bien: abrir las sesiones desde el panel

En vez de arrancar `claude` a mano en cada terminal, deja que lo haga el panel en las máquinas con **squadra-host**:

1. **Añade la máquina.** En **🖥️ Máquinas → + Añadir máquina**, elige el sistema de la máquina y ejecuta allí el único comando que te da el panel (en una terminal; en Windows, en PowerShell). En Linux es así:

   ```bash
   curl -fsSL 'https://squadra.example.com/install/linux.sh' | bash -s -- 'https://squadra.example.com' ABCD-2345 --sha256 <sha256>
   ```

   Instala lo que falte (tmux, Node.js 22, Claude Code), comprueba el squadra-host que descarga, cambia el código de un solo uso (válido 15 minutos; guarda el comando en privado hasta entonces) por la credencial propia de la máquina, e instala el plugin de Squadra, el comando `squadra-host` y un servicio que la mantiene en marcha en segundo plano y arranca con el equipo (systemd en Linux y WSL, launchd en macOS). Los instaladores están en [`install/`](../install/): `linux.sh`, `macos.sh` y `windows.bat` (en Windows, Squadra funciona dentro de WSL; si hace falta, el comando te dice cómo instalarlo). Después ejecuta `claude` una vez en la máquina e inicia sesión.
2. **Elige sus carpetas.** En la tarjeta de la máquina, **+ Carpeta** permite una carpeta donde se pueden abrir sesiones (y todo lo que contiene), y ✕ la quita. La máquina comprueba cada una: nunca una carpeta del sistema, temporal o de credenciales, ni tu carpeta personal entera, salvo que squadra-host se arrancara con `--allow-home` (márcalo en el diálogo «+ Añadir máquina»), para que Claude administre el equipo. Las sesiones en la carpeta personal acceden a todos tus ficheros, así que sus permisos se aprueban solo en su propia terminal, nunca desde un coordinador.
3. **Abre una sesión.** **+ Nueva sesión**: máquina, rol, nombre, coordinador (elegido entre los que existen), carpeta (una de las permitidas en la máquina, más una subcarpeta opcional), cuándo autocompactar (600K tokens por defecto, lo recomendado para modelos de 1M de contexto) y si continuar la última conversación. Arranca `claude` con el canal de Squadra en tmux y hace login sola.
4. **Usa su terminal.** La sesión se abre en una terminal web en vivo. La primera vez, acepta el aviso de canales en desarrollo y, si lo pide, confía en la carpeta y haz `/login`. Desde ahí puedes verla o escribirle desde cualquier navegador; el chat y el mosaico siguen funcionando igual.

En la máquina (`squadra-host help` lo muestra todo):

| Comando | |
|---|---|
| `squadra-host status` | Servidor, ajustes y sesiones abiertas |
| `squadra-host update` | Actualiza squadra-host y el plugin a la versión del servidor (las sesiones abiertas siguen funcionando) |
| `squadra-host folders add <ruta>` | Permite una carpeta desde la propia máquina (también `folders remove <ruta>`, `folders`) |
| `squadra-host --allow-home` | Permite tu carpeta personal entera (`--no-allow-home` para deshacerlo) |
| `squadra-host service` | Funciona en segundo plano y arranca con el equipo (`service remove` para dejar de hacerlo) |
| `tmux -L squadra attach -t sq-<nombre>` | Conectarte a una sesión en local |

Las reglas de la máquina están en `~/.config/squadra-host/settings.json`. El panel solo puede cambiar sus carpetas, y siempre dentro de las reglas de arriba:

| Ajuste | |
|---|---|
| `folders` | Dónde se pueden abrir sesiones, y todo lo que contienen. Nunca una carpeta del sistema o de credenciales, ni la carpeta personal entera salvo con `allow_home` |
| `folders_from_dashboard` | Si el panel puede añadir y quitar carpetas (`true`). Ponlo a `false` para cambiarlas solo en la máquina |
| `allow_home` | Si la carpeta personal entera puede ser una de ellas (`false`; lo activa `squadra-host --allow-home`) |
| `max_sessions` | Como mucho estas a la vez (8; máximo 64) |
| `allow_input` | Si el panel puede escribir en las terminales (`true`). Ponlo a `false` para solo mirar (terminales de solo lectura) |
| `allow_resume` | Si una sesión puede continuar la última conversación de su carpeta (`true`) |
| `permission_relay` | Si el coordinador de un worker puede responder sus permisos desde otra sesión (igual que `allow_input` por defecto; nunca en sesiones en la carpeta personal). Para las sesiones que abre squadra-host; para las arrancadas a mano en la máquina, pon `SQUADRA_PERMISSION_RELAY=off` en el `.env` del plugin |
| `coordinators` | Si se pone, los únicos nombres de coordinador que pueden recibir los workers que abre squadra-host en esta máquina |
| `claude_command` | El ejecutable de Claude Code (`claude`, buscado solo en las entradas absolutas del `PATH`) |

La máquina se conecta solo por HTTPS: `http` sin cifrar solo se acepta para `localhost`, o con `--insecure` en el alta, en una red privada de confianza. **Eliminar** (en la tarjeta de una máquina desconectada, o en su menú ⋯) revoca su credencial y la quita de la lista; una máquina que se dio de alta pero nunca llegó a conectarse aparece como *Pendiente de conectar* y se elimina igual. **Actualizar:** actualiza el servidor y después ejecuta `squadra-host update` en cada máquina (el panel dice cuáles son más antiguas); reinicia las sesiones que abrió para que usen el plugin nuevo. Actualiza también el plugin en las máquinas que configuraste a mano (`claude plugin marketplace update squadra && claude plugin update squadra@squadra`). **Desde 0.0.2:** las máquinas aún no tienen `squadra-host update`: vuelve a añadir cada una con «+ Añadir máquina» y elimina su entrada antigua. **Desde 0.0.1:** lo mismo, y además: con `SQUADRA_STATE_DIR`, mueve los ficheros de cada sesión a `<dir>/<nombre>/`; los scripts con `SQUADRA_ROLE`/`SQUADRA_COORDINATOR` necesitan un launch.json o un `/squadra:login`; reinicia todas las sesiones. El primer arranque de un servidor 0.0.2 o posterior limpia una vez los datos guardados por una versión anterior (dice en el log por dónde va).

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
- **Reduce lo que ve el panel en código sensible.** `--observe activity` envía qué herramientas usa un agente con argumentos cortos, su estado, los primeros 200 caracteres de tus prompts y la primera línea de los errores de herramientas (con los secretos enmascarados): ni el texto de Claude ni las salidas.
- **Máquinas de solo lectura.** Pon `allow_input: false` en los ajustes de squadra-host de una máquina cuando quieras ver sus sesiones pero no escribir en ellas desde la web.

## Qué puede hacer Claude

| Herramienta | |
|---|---|
| `reply(chat_id, text, reply_to?, files?)` | Escribe a una sesión o a un `#grupo`, con adjuntos si hace falta |
| `edit_message` | Actualiza un mensaje anterior (progreso) |
| `react` | Reacciona con un emoji; nunca despierta al otro lado |
| `download_attachment` | Descarga un adjunto a la bandeja local |
| `ping(chat_id?)` | ¿Está viva una sesión? Responde el servidor, no la sesión (solo de sesiones con las que has intercambiado mensajes o compartes grupo) |
| `login` · `logout` · `status` | Las usan los comandos `/squadra:*` |

## Seguridad

**Lo más importante: aísla las sesiones de las que no te fíes del todo.** Todas las sesiones de una máquina corren con el mismo usuario, así que una sesión comprometida (por ejemplo, por un repositorio malicioso) puede leer los ficheros de las demás sesiones de esa máquina, incluidos sus secretos de identidad y la credencial de squadra-host de la máquina, y todo lo que tú puedas leer. Si una sesión de una máquina puede estar comprometida, desconecta la máquina, dala de alta de nuevo y desconecta, y después elimina, todas las sesiones que corrieron en ella (una vez desconectada la propia máquina, sus nombres antiguos no se pueden volver a abrir hasta eliminarlos). Trata esa cuenta de usuario como comprometida: rehacerla es la única limpieza completa. Si la conservas, al menos reinstala el plugin de Squadra y revisa `~/.claude/settings.json`, `~/.claude.json`, `~/.claude/` (CLAUDE.md, agentes, comandos, `channels/squadra/`), los ficheros de arranque de tu shell y tus servicios de usuario antes de dar de alta la máquina de nuevo. Si entraste al panel desde un navegador de esa cuenta, cambia el token del servidor. Si allí corría un coordinador, revisa también las máquinas de sus workers. Si el `.env` del plugin de esa máquina tiene el token de alta, rótalo. Si el servidor o su carpeta de datos están ahí con el mismo usuario, también quedan expuestos su base de datos y su clave TLS: cambia el token del servidor, rota el token de alta, sustituye el certificado y la clave TLS, da de alta de nuevo todas las máquinas y desconecta todas las sesiones. Mejor: ejecuta el servidor con su propio usuario o en su contenedor. Squadra limita lo que puede hacer con ellos (abajo), pero la única barrera real es el sistema operativo: pon el coordinador en su propia máquina, usuario o contenedor, y da a los workers que abren código no fiable un usuario, contenedor o VM propios.

- **Credenciales:**
  - el **token del servidor** (administración) entra en el panel, abre terminales web y ejecuta `/admin/*`. Su sitio es tu navegador y ningún otro;
  - el **token de alta** (`sj_…`) solo registra nombres de sesión *nuevos*, con límite de frecuencia. No abre terminales, no lee el panel ni se queda con un nombre. Las máquinas añadidas desde el panel no lo reciben salvo que marques la opción (los nombres de sus sesiones los registra el servidor);
  - cada nombre de sesión tiene su propio **secreto**, ligado al servidor que lo emitió. Cuando una sesión ocupa su nombre, el servidor solo acepta peticiones en su nombre desde esa sesión (un identificador que el plugin solo guarda en memoria), también durante un par de minutos tras reiniciar el servidor mientras se reconecta: un secreto copiado no puede hablar por una sesión conectada. Sí puede quedarse un nombre cuya sesión ya no existe (o ha dejado de responder: unos 15 segundos, hasta unos 45 si se cayó su red); por eso importa el aislamiento (arriba);
  - **Desconectar sesión** (⋯ en el panel) anula el secreto de la sesión: quien tenga una copia se queda fuera para siempre, y se descarta lo que tenía en cola para otras sesiones. Una sesión abierta desde el panel puede abrirse de nuevo desde su máquina (tras cerrar su terminal) mientras esa máquina siga dada de alta; si no, elimina el nombre para volver a usarlo. **Eliminar** una sesión también descarta sus mensajes en cola, y las sesiones que hablaban con ella no aceptan mensajes de una nueva sesión con ese nombre hasta que ejecutes allí `/squadra:access unpin <nombre>`. Un worker cuyo coordinador se eliminó y se registró de nuevo a propósito necesita además borrar `coordinator-pin.json` de su carpeta de estado y volver a hacer login; los aprobadores de un coordinador se comprueban con los mismos pins;
  - rota el token de alta con `curl -X POST <url>/admin/rotateJoinToken -H "Authorization: Bearer <token-del-servidor>"` (las sesiones existentes siguen funcionando; las máquinas necesitan el nuevo para registrar nombres nuevos; no si viene de `SQUADRA_JOIN_TOKEN`: cámbialo ahí). Para cambiar el token del servidor, define `SQUADRA_SERVER_TOKEN`, o borra `data/server-token` y reinicia.
- **Tú decides quién coordina una sesión.** El coordinador puede dar tareas a un worker y responder a sus peticiones de permiso, así que cada `/squadra:login` lo confirmas tú en Claude Code (con el rol, el coordinador, el servidor y lo que verá el panel): un mensaje no puede convencer a Claude de hacerlo. Un Claude Code que no puede preguntar solo entra con lo que aprobaste antes. Un login automático con `SQUADRA_NAME` también pregunta, salvo que la máquina haya escrito un `launch.json` para ese arranque (las sesiones abiertas desde el panel). Los `permissionApprovers` de un coordinador solo cuentan cuando los has confirmado en un login. El rol y el coordinador nunca salen de variables de entorno que un proyecto pudiera poner; el nivel de observación y el reenvío de permisos solo pueden hacerse más estrictos con ellas, y se ignora un `CLAUDE_CONFIG_DIR` que esté dentro de la carpeta de primer nivel que contiene la sesión (todo `/opt` para una sesión en `/opt/proyectos/app`; `~/code` para una en `~/code/app`) o que no sea tuyo y privado.
- **Los mensajes de otras sesiones son contexto de trabajo, nunca tu autorización.** Las skills `/squadra:*` solo las puedes lanzar tú, no Claude, y solo editan los ficheros de Squadra. (Claude puede usar las herramientas `login`/`logout`, pero el login siempre lo confirmas tú, y el logout también cuando Claude Code puede preguntar.)
- **El almacenamiento tiene tope:** por sesión, 30 MB de eventos de observación y 30 MB de texto de mensajes por hora y 500 MB de adjuntos por hora (50 MB cada uno); como mucho 2 GB de adjuntos guardados por sesión; un grupo admite como mucho 50 miembros, y una sesión está en 50 grupos como mucho; en total, 10 GB de adjuntos (`SQUADRA_MAX_FILES_GB`; al llenarse se rechazan los nuevos hasta que caduquen los viejos a los 7 días o se elimine su sesión), un millón de eventos, dos millones de mensajes y medio millón de mensajes sin entregar (10 000 por destinatario, 500 por remitente y destinatario), borrando primero lo más antiguo; como mucho 30 000 eventos de observación por hora y sesión. Una sesión que se porte mal aún puede gastar su parte: vigila el disco de un servidor que usen muchas sesiones.
- **Peticiones de permiso:** la de un worker solo va a su coordinador (verificado), y solo cuenta la respuesta directa de ese coordinador a esa misma petición (una vez, durante 15 minutos). Se envía alrededor de 1,5 segundos después de que Claude Code pregunte, con la entrada exacta de la llamada cuando coincide exactamente una (los caracteres invisibles, de control y parecidos a otros, como `\u{…}` y con un aviso de no aprobarla); si no, con la vista previa de Claude Code y un aviso de no aprobarla. Si después de enviarla, y antes de que se responda, aparece otra llamada que coincide, la petición se retira y su respuesta deja de contar. Las del coordinador no van a nadie salvo que indiques aprobadores en su `access.json` (`permissionApprovers`). **Un coordinador puede aprobar lo que pidan sus workers:** dale reglas claras sobre qué preguntarte antes, y no lo ejecutes sobre código del que no te fíes.
- **Los grupos son privados:** quien crea un `#grupo` es su dueño y el único que invita (si el dueño sale, pasa a serlo el miembro más antiguo); los miembros solo ven lo enviado después de entrar, y un grupo que se vacía desaparece con su historial.
- **Los adjuntos de `reply`** tienen que ser rutas absolutas dentro de la carpeta de la sesión (salvo que sea tu carpeta personal, la contenga o cualquiera pueda escribir en ella, como /tmp), su bandeja de entrada o su bandeja de salida (`<estado>/outbox`), y nunca credenciales (`.env`, `id_*`, `*.pem`, `.git/`, nada de `~/.ssh`, `~/.aws`, `~/.claude`…), historiales de la shell, enlaces duros ni ficheros del sistema; un enlace simbólico se sigue y su destino tiene que pasar las mismas comprobaciones. En el texto de los mensajes se enmascaran los secretos claros: formatos de clave conocidos, claves privadas, contraseñas en URLs, valores Bearer/Basic/Token, opciones `--password=`/`--token=` y NOMBRE=valor (o NOMBRE: valor) cuando el nombre contiene password, passwd, passphrase, secret, token, credential o api/access/private/account key y el valor empieza por 8 o más letras, dígitos o `+ / _ ~ . @ # $ % ^ & * ! -`, con letras y dígitos: esa parte se enmascara (no si le sigue `(`, ni si empieza por `/` o `#` sin comillas). Otros nombres `*_KEY`, valores solo de letras o solo de dígitos, valores cortos, `*_PASS`/`*_PWD`, frases entre comillas, opciones seguidas de un espacio (`--password x`) y cookies no. Es una red de seguridad, no una garantía: no pegues secretos en los mensajes.
- **El coordinador queda fijado:** un worker recuerda la identidad del coordinador con el que habló por primera vez; si ese nombre lo registra después otra persona, lo ignora y te avisa.
- **Nombres:** los que abre el panel quedan reservados para su máquina desde ese momento. Los que nadie ha usado todavía son del primero que los registra: el administrador puede desconectar (⋯ → Desconectar sesión) y eliminar una sesión que se haya quedado uno que no le toca.
- **El panel puede recibir código y salidas de comandos** (nivel de observación `full`). Usa TLS si el servidor no es local, o baja el nivel por sesión con `--observe activity` u `off`. Los secretos reconocibles se enmascaran (claves de API, `*_TOKEN=`, contraseñas en URLs, opciones `--password`/`--token` y las de contraseña de herramientas habituales como `mysql -p`, `docker login -p` o `curl -u`, cookies, claves privadas), y de los comandos y escrituras que tocan `.env`, claves o credenciales no se envían ni sus argumentos, ni su contenido, ni su salida. Las peticiones de permiso que se reenvían a un coordinador son mensajes: su entrada llega al servidor y al panel sea cual sea el nivel de observación, solo con el enmascarado más ligero de los mensajes. Es una red de seguridad, no una garantía: lo que una sesión cuenta de sí misma lo declara ella, y una sesión comprometida puede ocultar su actividad.
- **Los WebSockets** (terminales web y máquinas) solo se aceptan con una credencial en la propia petición: un ticket de un solo uso para el panel y el secreto de la máquina para squadra-host. Nadie sin credencial puede mantener una conexión abierta. La credencial viaja en la cabecera `Sec-WebSocket-Protocol`: si tu proxy registra las cabeceras de las peticiones, exclúyela.
- **La página del panel** funciona con una Content-Security-Policy estricta, no se puede meter en un iframe y no carga scripts de terceros (xterm.js lo sirve el propio servidor). Al texto que se pega en un terminal web se le quitan los caracteres de control.
- **Máquinas con squadra-host:**
  - nunca ejecutan lo que manda el servidor: solo una especificación de sesión, validada contra sus ajustes locales, con un comando fijo; el panel puede añadir y quitar carpetas permitidas, pero la máquina comprueba cada una con las reglas de abajo (y `folders_from_dashboard: false` las deja solo en manos de la máquina); los destinos de tmux son exactos; los ficheros de sesión (identidad, arranque, el `.env` del plugin) se escriben sin seguir enlaces simbólicos;
  - hablan con el servidor solo por HTTPS (http sin cifrar solo a `localhost`, o con `--insecure` en una red de confianza); el comando de alta se ejecuta en una carpeta temporal nueva y comprueba el sha256 del programa, y el plugin se instala desde una versión etiquetada. **Guarda en privado el comando de alta hasta usarlo**: es una llave de un solo uso para añadir una máquina, y la que se añada con él recibe los secretos de las sesiones que abras en ella y lo que escribas en sus terminales (también un `/login`). Si después dice que el código no vale o caducó aunque acabas de crearlo, alguien lo usó: elimina la máquina que añadió;
  - no se pueden abrir sesiones en tu carpeta personal (salvo que squadra-host se arrancara con `--allow-home`: entonces los permisos de esas sesiones se aprueban solo en su propia terminal), en una carpeta que la contenga (`/home`, `/Users`), en carpetas temporales compartidas, en carpetas de otro usuario (ni dentro de una, ni dentro de una carpeta en la que cualquiera puede escribir sin el bit sticky), en una carpeta en la que puede escribir otro grupo (que no sea el tuyo privado) o alguien gracias a una ACL, ni donde viven credenciales y cachés; ninguna carpeta queda permitida hasta que añades una;
  - `tmux` y `claude` solo se toman de carpetas tuyas o de root que nadie más puede cambiar (ni otro usuario, ni un grupo compartido, ni una ACL, tampoco en las carpetas superiores; en macOS se acepta el grupo `admin`, el que usa Homebrew), nunca de una carpeta donde se abren sesiones; una ruta con enlaces simbólicos (los shims de los gestores de versiones, el `opt/` de Homebrew) se usa tal cual solo si cada enlace y cada carpeta del camino hasta el programa pasan las mismas comprobaciones. Los shims que eligen el programa según la carpeta actual (volta, asdf, nodenv) se sustituyen por el `claude` y el `node` que eligen desde tu carpeta personal, para que un repositorio no pueda elegirlos; si no se encuentra, pon en `claude_command` el ejecutable real. Claude Code y las sesiones reciben un PATH solo con carpetas así (sin entradas relativas), de modo que su `node` tampoco puede venir de un repositorio. Tu propio grupo solo cuenta como privado si lleva tu nombre y nadie más está en él; las ACL se leen con el `ls` del sistema. Si `settings.json` no se puede leer, la máquina funciona con los ajustes más estrictos (sin carpetas ni escritura) hasta que se arregle;
  - **el servidor sigue siendo de confianza para dar instrucciones:** quien lo controle (o controle el panel) puede escribir en los terminales con `allow_input` activado, y dar tareas a los workers a través de su coordinador. En las máquinas que solo quieras mirar, pon `allow_input: false` (el panel no puede escribir ni cambiar el tamaño de los terminales y, salvo que los ajustes de esa máquina pongan `permission_relay: true`, se desactivan las respuestas remotas a permisos en las sesiones que abre) y fija `coordinators`. Deja sin marcar **«Dar también a esa máquina el token de alta»** al añadir una máquina salvo que lo necesites. La propia configuración de Claude Code de un repositorio (hooks, servidores MCP) se ejecuta cuando confías en su carpeta: abre solo repositorios de confianza, o aísla la máquina.

## Estado y limitaciones

- **Versión 0.0.3:** temprana, pero cubierta por pruebas de punta a punta: `npm test` arranca un servidor real, procesos reales del plugin hablando MCP y squadra-host con un tmux real. El flujo de GitHub Actions las ejecuta en Linux y en macOS.
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

[MIT](../LICENSE): puedes usarlo, copiarlo, modificarlo y distribuirlo libremente, para cualquier fin.
