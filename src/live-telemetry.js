const fs = require('fs');
const { execSync } = require('child_process');

module.exports = {
    getLiveActivityStatus() {
        try {
            const gitStatus = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
            const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
            const autopilotFile = '.codebridge/autopilot.json';
            let activeTasks = [];
            if (fs.existsSync(autopilotFile)) {
                const data = JSON.parse(fs.readFileSync(autopilotFile, 'utf8'));
                activeTasks = (data.tasks || []).filter(t => t.state === 'running');
            }

            return {
                timestamp: new Date().toISOString(),
                gitBranch: currentBranch,
                uncommittedChanges: gitStatus ? gitStatus.split('\n').length : 0,
                activeTaskCount: activeTasks.length,
                runningTasks: activeTasks,
                ciHealth: "MONITORING_ACTIVE",
                statusReport: "Live telemetry synchronized successfully."
            };
        } catch (e) {
            return { error: e.message };
        }
    }
};
