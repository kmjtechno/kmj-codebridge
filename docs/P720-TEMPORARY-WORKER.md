# Lenovo P720 — temporary local AI readiness

This is a **zero-spend, non-destructive verification** for the temporary KMJ P720 development workstation. It is not a self-hosted GitHub runner, an autonomous agent installer or a claim that any KMJ project is finished.

## Run on the already prepared Windows workstation

Use `scripts\\RUN-P720-AI-CHECK.cmd` from this repository, or run:

```powershell
node scripts/p720-ai-check.mjs
```

The CMD launcher writes `D:\\KMJ-HyperSpeed\\P720-AI-READINESS.json` and returns exit code 0 **only if both endpoints generated real tokens and Ollama reported GPU VRAM offload**. Otherwise it returns exit code 2. Run from a current, trusted copy of this repository.

It checks only `http://127.0.0.1:11435` for `qwen2.5-coder:7b` and `http://127.0.0.1:11436` for `qwen3:4b`. The script does not pull models, restart processes, modify services or GPU drivers, touch Git branches, send source code to providers, enable spending, deploy to production or elevate privileges.

The check loads one model at a time with a 2048-token context and a maximum of 48 generated tokens. Ollama's `/api/ps` reports offloaded VRAM bytes, but **does not prove which physical P4000 executed the model**. Validate GPU placement separately with `nvidia-smi` while inference is running. On Pascal GPUs, available CUDA 12 and Vulkan backends may be different from new CUDA 13 compiled architectures.

A passing local AI readiness report **does not mean CodeBridge P720 enrollment is complete**. That still requires an authorized project, HTTPS pairing approval, credentials stored outside source and a verified online device grant. The temporary P720 worker must not be given a production checkout or production secrets.

## Acceptance before running autonomous development

1. Both worker endpoints generate tokens and report VRAM offload on the workstation.
2. CodeBridge shows a distinct, authorized P720 device and intended project scopes, with no project permission escalation.
3. Exact project commits and fixed quality gates pass. GitHub required checks remain authoritative until an explicitly reviewed policy changes.
4. ModelFabric free provider quotas and private-source data policies are verified. Local mode is a backup; it is not an unlimited free cloud quota.
5. The temporary workstation can be stopped, removed and migrated without changing production infrastructure.

For broader planning see `docs/HYPERSPEED.md` and `docs/NATIVE-CI-EQUIVALENCE.md`.
