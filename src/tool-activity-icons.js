// Fixed 32x32 PNG glyphs for native MCP tool activity, not a status claim.
// No network requests, SVG scripts, user content, or new dependencies.
const glyphs = {
  device:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAp0lEQVR42u2XwQ2AMAhFW8IkOpOOoDPpCDqTrqInE2NqW4VCD3Ct4X2/WPKdUy7/dtAMy8EJ2ufeZwngBqeEgCQ8xABJeIgF2kMI0m//dAFjD21TxwJrxzXuQEl4qhdS1FPh9QyhCTABJsAEaFbyKubcCZ8coO6A3F5IXUSXQ38F1z8DpWcBuRqFBOZ8FoiFBol8gByTzPIbSrpwZ0FOfisZzdTDqXqd5K08SMGz8ZsAAAAASUVORK5CYII=",
  git: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA0UlEQVR42t2X3Q2DMAyEyYnV6ABlmXaCsgwdoAwHT61QhYnjXGwJPyEIfOcf4rjrgi1JDx7DvDJB0zImlQA2OCcEnvAjBjzhR6xe88Lrc/9dP29vfhGeeb+Ha0SUiJ2WMUHrueW+tE4swhorFUsXYLVTAVIOmYWYjcA/rBSeWw/GR6Q8a8T2zOKzpAaRcHMEmDsjIuFVKWD9ioiEqwW07Ibw9rg6Au4CLC2WJsDaYt12wusIkIaGlueBL7P5eaBoNPOaDfYRh2Z+azmahQ+n4bYBMZ5jGAQLnkoAAAAASUVORK5CYII=",
  verify:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAyklEQVR42t2XwQ2DMAxFiaegA5Yh2jMdAgYsW9BTpCpK4u842BG5cEDKezEm+p4m5xVKL+bX8+wJOj57gAR6gzkRsoTnGGQJz7HIuwnJ+vRpFcaowK0FvuvmJxDhNQmyOnlJgqzK/ngvNgISeHcBKRwS4LpYA2cFkC7WwKsCaBdr4FWB3CaIlATOfoKaRA841IRIJVrh8G/Ibd4KF90DJYgGLr6IIix9qmO5RyKKCXmMQFIaGizmg3EimWUV/lmEzG9Xjmbuw6n7+gHfdGVFU+omcAAAAABJRU5ErkJggg==",
  read: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAwElEQVR42u1XwQ2AIAyEhlF0LN1Ch9AtdCzdRV9NCAGh2lIf8FMS7nrtEc4Y5WVTG92wXJxA5z7bIgLcwDkiUBM8hgE1wWNY8IshTFV/bBP5wH5cSfOgroDjquqNWr+YgUagEWAnQHWDkwDEfyX2ZVeAchN+JpCqFL9L2tFcABz9DqVWHUIRG1IP9ZXJqSBmQySdI28l34M+eEwJ8ReRD5pSAp5CgyQJxKxyDyCJWBts7WASKg4l+U0ymqmHU/V1A6vLWi+hwO3MAAAAAElFTkSuQmCC",
  write:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAwUlEQVR42sWXQQ6EIAxFteEQerVRT6fO1cZb6MoEDWLp/E+7IYHFey0NpE3jHO3TwfzpdiRo+m6tSgANfhORmvAUQ2rCUyzxbkJhZD+uv8uaqwK8And4TgIuEMOWoU/u0wRScI2EMDPXSAgTrjkXT/hfAgi4WQAFNwkg4cUCaHiRAAOuFmDBi68ADVcJnAAGnPoOaCNYoQj4q0AMzF0FTQCVpVmACb404dPQUGM+CJbGKw3Vb1izCjHLfTRzH07d4wDMVIkLTXjTmAAAAABJRU5ErkJggg==",
  supervisor:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA80lEQVR42sWXTRaDIAyENc8btsv2LNKz6FLP2K7ssz5iJzMgbPn5JiQhpOsaj96buD3SuyRonVMPCSgN/ifEroTnGHYlPMcy9bBlGvUgZKzPge/PVzgeBgW8By7T+J2LCBkUqGc9sh5yQeQgZv86px4KQgaO7rOu8agiIJKaVguOirBalqNxY0gQ7Q/2LMvBkXfBSlyvkq7GplVODJOupuS2CqeD8Ahj4SEBR79vUA+OpiFUjj24ujZUCzzfn2VD8VpwJoINSOpHdObfCJz6EXkvpJSGXtOACmHgG1MuRsob8COAvQW1OzKkf6vZmjVvTpuPD0mhl6gLI+fzAAAAAElFTkSuQmCC",
  workflow:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAArUlEQVR42u1XwQ2AIAyExq10Dd1BBtIdZA2ZS18kPqCFQKmP9tvKHc3ZcsYIh80ljnl9egK54G0Rgd7AFBEYCZ7CgJHgKSz4hQhzt9/vK/vhuWzN9S54m+0AdlgqX1sfY6Ja1OOmWL24BpSAOAFShJS6W+uhRs1Yvra+aBBxBzqIVIQjdgHaAd0FOor1Nxy6C1KmgXsXREwr8Sz/EgDKOnG7Iyjxb5zWTNyciscLgipjUzOZVpIAAAAASUVORK5CYII=",
};

const categories = [
  [/^(?:connection_|list_devices$|account_diagnostics$)/, "device"],
  [/^(?:github_|git_)/, "git"],
  [/^(?:run_quality_gate$|verification_|ide_run_project_task$)/, "verify"],
  [
    /^(?:read_|list_directory$|project_tree$|search_code$|fast_read|fast_context$|repo_|inspect_project$)/,
    "read",
  ],
  [
    /^(?:write_|edit_file$|create_project_directory$|move_project_file$|copy_project_file$)/,
    "write",
  ],
  [/^supervisor_/, "supervisor"],
  [
    /^(?:autopilot_|mission_|browser_|ide_|chat_|compact_session_|coordination_|model_|skill_|execution_capacity$|run_project_command$|get_job_status$|cancel_job$)/,
    "workflow",
  ],
];

export function toolActivityIcons(name, brandIcons, customIcon = false) {
  if (customIcon || typeof name !== "string") return brandIcons;
  const key = categories.find(([pattern]) => pattern.test(name))?.[1];
  if (!key) return brandIcons;
  return [
    {
      src: "data:image/png;base64," + glyphs[key],
      mimeType: "image/png",
      sizes: ["32x32"],
    },
  ];
}
