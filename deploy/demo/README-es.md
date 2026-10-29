# Demo de Squadra (Docker)

El panel y una máquina que ejecuta Claude Code, en un solo contenedor: la forma más rápida de probar Squadra en un equipo. Para un uso real, el panel y las máquinas van por separado: mira el [README principal](../../README-es.md).

## Arráncala

Desde la raíz del repositorio:

```bash
docker compose -f deploy/demo/docker-compose.yml up -d --build
docker compose -f deploy/demo/docker-compose.yml logs    # el token para entrar
```

1. Abre **http://localhost:7787** y entra con el token de los logs (también está en `deploy/demo/squadra/data/server-token`).
2. **+ Nueva sesión**: carpeta `/squadra/projects/demo`, rol *Coordinador*, persona `project-lead`.
3. La primera vez, Claude Code pide en el terminal de la sesión el tema, tu login de Claude (`/login`: abre el enlace y pega el código) y si confías en la carpeta. El login se guarda para todas las sesiones siguientes.
4. Desde la escuadra (👥), **+ Worker**: uno con la persona `developer` y otro con `designer`. Después pide al coordinador algo pequeño.

## Dónde está todo

Todo vive en `deploy/demo/squadra/`, y es tuyo:

| Carpeta | Qué |
|---|---|
| `data/` | El panel: sus tokens, sesiones, mensajes y plantillas |
| `home/` | La carpeta personal del contenedor: el login y los ajustes de Claude Code, el plugin de Squadra y la credencial de la máquina |
| `projects/` | Donde se pueden abrir sesiones. `demo/` es un proyecto de ejemplo con tres personas en `.claude/skills/` |

Pon tus proyectos en `projects/` (o monta otra carpeta ahí). Borra `deploy/demo/squadra/` para empezar de cero.

## Conviene saber

- Solo este equipo llega a ella (`127.0.0.1:7787`). El aviso del servidor sobre HTTP sin cifrar habla de la red: con esta configuración nada sale del equipo.
- Claude Code solo trabaja con lo que hay en `projects/`: el resto de tu equipo no está en el contenedor.
- Para actualizar: `git pull` y el mismo `up -d --build`. El plugin es el de este repositorio y se reinstala cuando cambia la imagen; reinicia las sesiones abiertas para usarlo.
- Otro puerto: cambia `127.0.0.1:7787:7787` por, por ejemplo, `127.0.0.1:8080:7787` y abre http://localhost:8080.
- Para pararla: `docker compose -f deploy/demo/docker-compose.yml down` (la carpeta se queda).
