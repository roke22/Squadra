<p align="center"><img src="branding/squadra-logo.svg" width="96" alt="Logo de Squadra"></p>

<h1 align="center">Squadra: Claude Code multiagente con un coordinador y un panel en directo</h1>

<p align="center"><b>Un agente coordinador que dirige escuadras de agentes de Claude Code: rápido, desatendido y a la vista en directo.</b></p>

<p align="center">
  <a href="https://github.com/roke22/Squadra/releases"><img src="https://img.shields.io/github/v/release/roke22/Squadra?label=release&color=C15F3C" alt="Última versión"></a>
  <a href="https://github.com/roke22/Squadra/actions/workflows/test.yml"><img src="https://github.com/roke22/Squadra/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="Licencia MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Sin dependencias">
  <a href="https://github.com/roke22/Squadra/stargazers"><img src="https://img.shields.io/github/stars/roke22/Squadra?style=social" alt="Estrellas en GitHub"></a>
</p>

<p align="center"><a href="README.md">Read in English</a> · <a href="https://roke22.github.io/Squadra/">Web</a> · <a href="docs/referencia.md">Referencia</a> · <a href="https://github.com/roke22/Squadra/discussions">Discussions</a></p>

---

Squadra le da a [Claude Code](https://claude.com/product/claude-code) un **coordinador**: le dices lo que quieres y él reparte el trabajo entre una escuadra de **workers** (otras sesiones de Claude Code), sigue cómo avanzan, aprueba sus acciones seguras y solo vuelve a ti para las decisiones importantes.

Un panel web muestra toda la escuadra en directo, como una pared de terminales: qué hace cada agente, qué dice Claude y quién te está esperando. Desde ahí también añades tus equipos y abres sesiones nuevas en ellos.

Squadra es **orquestación multiagente para Claude Code**: varias sesiones de Claude Code en paralelo, en un equipo o en varios, coordinadas por otra sesión de Claude Code, con un panel web autoalojado y una terminal web para lanzarlas y vigilarlas desde cualquier navegador. Es código abierto (MIT), un único servidor Node.js sin dependencias, y se instala como plugin de Claude Code.

![Panel de Squadra: dos escuadras lado a lado, cada coordinador con sus workers](docs/screenshots/mosaic-squads.jpg)

## Qué puedes hacer con él

- **Hacer una funcionalidad en varios repositorios a la vez:** el backend, la web y la app móvil, cada uno con su worker, coordinados entre sí.
- **Partir un trabajo grande en piezas en paralelo:** una migración, una refactorización o más tests, un worker por módulo.
- **Dejarlo trabajando solo:** los workers deciden los detalles técnicos y el coordinador aprueba sus acciones seguras, así la escuadra sigue mientras no estás.
- **Vigilarlo desde cualquier sitio:** todos los agentes en directo en tu navegador, y una barra «Te necesitan» con quien espera una respuesta.
- **Usar todos tus equipos y cuentas:** cada agente funciona en cualquier máquina que añadas, con la sesión de Claude Code de esa máquina.

## Squadra frente a los Agent Teams y subagentes de Claude Code

Claude Code ya tiene [subagentes](https://code.claude.com/docs/en/sub-agents) y los Agent Teams experimentales. Squadra es para cuando se quedan cortos:

| | Subagentes | Agent Teams | Squadra |
|---|---|---|---|
| Los agentes corren en | la misma sesión | el mismo equipo | **cualquier equipo que añadas**, cada uno con su sesión de Claude Code |
| Verlos | en una terminal | una terminal por agente | **un panel web en directo** con todos los agentes, desde cualquier navegador |
| Trabajo desatendido | apruebas cada aviso | apruebas cada aviso | **el coordinador aprueba las acciones seguras**, a ti solo te llegan las críticas |
| Abrir y reabrir sesiones | a mano | a mano | **desde el panel**, con una terminal web a cada agente |
| Varios repositorios a la vez | no | el directorio del lead | **un worker por repositorio**, en el equipo que lo tiene |

Squadra no sustituye a Claude Code: cada agente es un `claude` interactivo normal, así que puedes entrar y escribir en cualquiera de ellos en cualquier momento.

## Qué necesitas

- **Una cuenta de Claude Code** con un plan de claude.ai (Pro, Max, Team o Enterprise) o una clave de API de Anthropic Console. En Team y Enterprise, un Owner activa *Channels* en los ajustes de la organización.
- **Un equipo para el panel,** con [Node.js 22](https://nodejs.org) o Docker. Puede ser el mismo equipo donde trabajan tus agentes.

En los equipos donde trabajan los agentes se instala todo lo demás solo, al añadirlos (paso 2).

## 1. Instala el panel

```bash
git clone https://github.com/roke22/Squadra.git squadra && cd squadra
node server/server.js
```

Abre **http://127.0.0.1:7787** y entra con el **token del servidor** que muestra al arrancar (también se guarda en `data/server-token`).

**Con Docker**, en su lugar:

```bash
docker build -f server/Dockerfile -t squadra-server .
docker run -d --name squadra-server -p 127.0.0.1:7787:7787 -e PUBLIC_URL=http://127.0.0.1:7787 -v squadra-data:/data squadra-server
docker logs squadra-server      # muestra el token del servidor
```

**Para usarlo desde otros equipos,** dale un dominio: apunta el dominio a este equipo, abre los puertos 80 y 443, y arráncalo con

```bash
node server/server.js --domain squadra.example.com --acme-email tu@example.com
```

Consigue y renueva su certificado HTTPS solo, y el panel queda en `https://squadra.example.com`. (En Linux, los puertos 80 y 443 necesitan privilegios: arráncalo con `sudo`, o usa la imagen de Docker con `-p 80:80 -p 443:443 -e SQUADRA_DOMAIN=squadra.example.com`.)

## 2. Añade tus equipos

En el panel, abre **🖥️ Máquinas → + Añadir máquina**, elige el sistema del equipo (Linux, macOS o Windows) y **sigue las instrucciones que te muestra**: es un único comando para ejecutar en ese equipo. Instala todo lo que necesita y lo conecta a tu panel.

Después, desde el panel:

1. **+ Carpeta** en la tarjeta de la máquina: elige las carpetas donde pueden trabajar los agentes (tus proyectos).
2. **+ Nueva sesión**: abre un **coordinador** y luego sus **workers**. Cada uno se abre en una terminal en directo en tu navegador. La primera vez, acepta los avisos de Claude Code (para el canal de desarrollo, elige *"I am using this for local development"*).
3. **Habla con el coordinador** en su terminal y dile lo que quieres hacer.

## Buenos consejos

- **Usa HTTPS** (un dominio, paso 1) cuando otros equipos se conecten a tu panel, y guarda el token del servidor solo para ti: es la llave del panel.
- **Dale al coordinador su propio repositorio** con un `CLAUDE.md` que describa tu equipo: qué worker lleva cada repositorio, cuándo una tarea está terminada y qué debe consultarte siempre. Así cada coordinador que abras desde él trabaja igual.
- **Pon a los workers nombres de lo que hacen** (`api`, `web`, `docs`): el coordinador los usa para decidir a quién da cada tarea.
- **Un worker por repositorio o por área,** para que no editen los mismos ficheros. Para trabajar en paralelo en un mismo repositorio, dale a cada worker su propio [git worktree](https://git-scm.com/docs/git-worktree).
- **Abre tus propios proyectos,** o repositorios de confianza, en las carpetas de los agentes.
- **Deja espacio en el contexto:** con modelos de 1M de contexto, el autocompactado a 600K tokens que trae el panel por defecto mantiene a los agentes en forma.

## Actualizar

Actualiza el panel (`git pull` y arráncalo de nuevo, o reconstruye la imagen de Docker) y después ejecuta `squadra-host update` en cada equipo. El panel te dice cuáles están desactualizados.

## Saber más

- [docs/referencia.md](docs/referencia.md): configurar agentes a mano sin el panel, todas las opciones del servidor y cómo funciona todo por dentro.
- [PLAN.md](PLAN.md): la guía técnica completa.

## Contribuir

Los errores y las ideas van a [Issues](https://github.com/roke22/Squadra/issues); las preguntas y lo que hayas montado con Squadra, a [Discussions](https://github.com/roke22/Squadra/discussions). En [CONTRIBUTING.md](CONTRIBUTING.md) está cómo ejecutar los tests y enviar un pull request. Si Squadra te resulta útil, una ⭐ en GitHub ayuda a que lo encuentre más gente.

## Licencia

[MIT](LICENSE): libre para usar, copiar, modificar y distribuir, para cualquier fin.
