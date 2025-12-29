const fs = require('fs');

/**
 * Reads a JSON file safely, handles BOM and empty files.
 */
function readJSON(filePath, defaultValue = {}) {
    try {
        if (!fs.existsSync(filePath)) return defaultValue;
        let content = fs.readFileSync(filePath, 'utf8');
        // Strip BOM if present
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        content = content.trim();
        if (!content) return defaultValue;
        return JSON.parse(content);
    } catch (err) {
        console.error(`Error reading ${filePath}:`, err.message);
        return defaultValue;
    }
}

/**
 * Writes a JSON file safely.
 */
function writeJSON(filePath, obj) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`Error writing ${filePath}:`, err.message);
        return false;
    }
}

module.exports = { readJSON, writeJSON };
