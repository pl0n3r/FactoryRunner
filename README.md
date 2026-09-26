# FactoryRunner

Execution plane autónomo de la fábrica de software de pl0n3r.

- **Factory** gobierna reglas, roles, CI y políticas.
- **ControlBot** decide qué trabajo ejecutar y conserva el estado durable.
- **FactoryRunner** ejecuta órdenes tipadas y reporta heartbeats/eventos.
- **AutoFactory** permanece como herramienta local/manual independiente y no se modifica.

## Runtime inicial

Node.js 24 LTS + TypeScript de sintaxis borrable, sin dependencias npm de runtime en el primer slice. El target primario es Hostinger Shared/Web Hosting; una instalación macOS local es únicamente fallback si una capability crítica demuestra ser inviable en el hosting.

## Seguridad

No se versionan passwords, cookies, tokens, private keys, DSN ni datos de sesiones reales. Las órdenes usan referencias opacas a instrucciones alojadas en ControlBot y el protocolo falla cerrado ante campos extra o evidencia sensible.

## Gobierno

Este repositorio consume Factory v1 para coordinación, etiquetas, política, aceptación, privacidad, CI y releases. Roadmap canónico: #1.
