const freeze = (value) => Object.freeze(value);

const PRESETS = freeze({
  "node-standard": freeze({
    node_deps: freeze({
      category: "network",
      description: "Install locked Node dependencies with npm ci.",
      command: "npm",
      variants: freeze({
        locked: freeze({ args: ["ci"], timeoutMs: 300000 }),
      }),
    }),
    node_verify: freeze({
      category: "build",
      description: "Run common bounded Node verification scripts.",
      command: "npm",
      variants: freeze({
        test: freeze({ args: ["test"], timeoutMs: 300000 }),
        build: freeze({ args: ["run", "build"], timeoutMs: 300000 }),
        check: freeze({ args: ["run", "check"], timeoutMs: 300000 }),
        lint: freeze({ args: ["run", "lint"], timeoutMs: 300000 }),
        typecheck: freeze({ args: ["run", "typecheck"], timeoutMs: 300000 }),
      }),
    }),
    node_format: freeze({
      category: "write",
      description: "Run the repository-defined Node formatter.",
      command: "npm",
      variants: freeze({
        write: freeze({ args: ["run", "format"], timeoutMs: 300000 }),
      }),
    }),
    node_dev: freeze({
      category: "build",
      description: "Run the repository-defined Node development process as a cancellable bounded job.",
      command: "npm",
      variants: freeze({
        start: freeze({ args: ["run", "dev"], timeoutMs: 300000 }),
      }),
    }),
  }),
  "python-standard": freeze({
    python_deps: freeze({
      category: "network",
      description: "Install Python dependencies from requirements.txt.",
      command: "python3",
      variants: freeze({
        requirements: freeze({
          args: ["-m", "pip", "install", "-r", "requirements.txt"],
          timeoutMs: 300000,
        }),
      }),
    }),
    python_verify: freeze({
      category: "build",
      description: "Run bounded Python verification.",
      command: "python3",
      variants: freeze({
        test: freeze({ args: ["-m", "pytest"], timeoutMs: 300000 }),
        compile: freeze({ args: ["-m", "compileall", "-q", "."], timeoutMs: 300000 }),
      }),
    }),
  }),
  "cargo-standard": freeze({
    cargo_verify: freeze({
      category: "build",
      description: "Run common bounded Cargo verification.",
      command: "cargo",
      variants: freeze({
        check: freeze({ args: ["check", "--locked"], timeoutMs: 300000 }),
        build: freeze({ args: ["build", "--locked"], timeoutMs: 300000 }),
        test: freeze({ args: ["test", "--locked"], timeoutMs: 300000 }),
        clippy: freeze({ args: ["clippy", "--locked", "--", "-D", "warnings"], timeoutMs: 300000 }),
        format_check: freeze({ args: ["fmt", "--", "--check"], timeoutMs: 300000 }),
      }),
    }),
    cargo_format: freeze({
      category: "write",
      description: "Format the authorized Rust project.",
      command: "cargo",
      variants: freeze({
        write: freeze({ args: ["fmt"], timeoutMs: 300000 }),
      }),
    }),
  }),
  "go-standard": freeze({
    go_verify: freeze({
      category: "build",
      description: "Run common bounded Go verification.",
      command: "go",
      variants: freeze({
        test: freeze({ args: ["test", "./..."], timeoutMs: 300000 }),
        vet: freeze({ args: ["vet", "./..."], timeoutMs: 300000 }),
        build: freeze({ args: ["build", "./..."], timeoutMs: 300000 }),
      }),
    }),
    go_format: freeze({
      category: "write",
      description: "Format the authorized Go project.",
      command: "gofmt",
      variants: freeze({
        write: freeze({ args: ["-w", "."], timeoutMs: 300000 }),
      }),
    }),
  }),
});

export const COMMAND_PRESET_IDS = Object.freeze(Object.keys(PRESETS));

const clone = (value) => structuredClone(value);

export function expandCommandPresets(presetIds = [], explicitCommands = {}) {
  const commands = {};
  for (const presetId of presetIds) {
    const preset = PRESETS[presetId];
    if (!preset) throw new Error("UNKNOWN_COMMAND_PRESET");
    Object.assign(commands, clone(preset));
  }
  return { ...commands, ...explicitCommands };
}
