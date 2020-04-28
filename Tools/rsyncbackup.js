#!/usr/bin/env /usr/local/bin/node

// <bitbar.title>RSync Backup Bitbar Plugin</bitbar.title>
// <bitbar.version>v1.0</bitbar.version>
// <bitbar.author>Gregory S. Read</bitbar.author>
// <bitbar.author.github>readgs</bitbar.author.github>
// <bitbar.desc>Schedule and monitor rsync backups via BitBar</bitbar.desc>
// <bitbar.dependencies>node npm/path npm/untildify npm/yargs npm/bitbar npm/date-and-time npm/date-diff npm/mkdirp</bitbar.dependencies>
// <bitbar.abouturl>http://gregread.com</bitbar.abouturl>

const path = require('path');
const untildify = require('untildify');
const yargs = require('yargs');
const bitbar = require('bitbar');
const fs = require('fs');
const date = require('date-and-time');
const DateDiff = require('date-diff');
const mkdirp = require('mkdirp');
const jsonc = require('jsonc');

/**
 * Enumeration of valid backup statuses
 */
const BackupStatus = {
    /**
     * No status available on backup (i.e. it hasn't run ever)
     */
    None: 0,
    /**
     * Last backup was successful
     */
    Succeeded: 1,
    /**
     * Last backup failed
     */
    Failed: 2,
    /**
     * Backup currently in progress
     */
    Running: 3
}

/**
 * Values that don't change :)
 */
const constants = {
    /**
     * Main folder where we store backup related stuff (like lock files, logs, etc)
     */
    WORKINGFOLDER: '~/.backup',
    /**
     * Name of lockfile we'll be using
     */
    LOCKFILE: 'backup.lock',
    /**
     * Name of file that will indicate the start of a backup
     */
    STARTFILE: 'start.flag',
    /**
     * Name of file that will indicate an error status
     */
    ERRORFILE: 'error.flag',
    /**
     * Name of file that will indicate a success status
     */
    SUCCESSFILE: 'success.flag',
    /**
     * Config file for user-configurable settings (source, destination, etc.)
     */
    CONFIGFILE: 'config.jsonc',
    /**
     * Name of excludes file for rsync
     */
    EXCLUDESFILE: 'excludes.txt',
    /**
     * Default content for the rsync excludes file
     */
    DEFAULTEXCLUDES: 
`.Trash/
.DS_Store`,
    /**
     * Default configuration content to use if no config file exists.
     */
    DEFAULTCONFIG:
`/**
* Configuration settings for backup
*/
{
    /**
     * Path to the rsync program.  The version included with macOS is ancient, so you
     * may want to install a newer version via homebrew.  In this case, you would want
     * to likely change this path to /usr/local/bin/rsync
     */
    "rsyncPath": "/usr/bin/rsync",
    /**
     * How often a backup should be executed.  Can expressed as a number, followed
     * by the time unit (seconds, hours or days).  For example...
     *      10s     Every 10 seconds
     *       5m     Every 5 minutes
     *       1h     Every 1 hour
     *       2d     Every 2 days
     *   manual     Backup is only done on-demand
     */
    "frequency": "1h",
    /**
     * Source to pass along to rsync for syncing data from
     */
    // ***UNCOMMENT LINE BELOW TO SPECIFY A SOURCE*** 
    //"source": "~",
    /**
     * Destination to pass along to rsync for syncing data to
     */
    // ***UNCOMMENT LINE BELOW TO SPECIFY A DESTINATION***
    //"destination": "/tmp/rsyncbackup/",
    /**
     * Additional arguments to pass to rsync.  Default arguments are reasonable
     * for a standard archival copy of the source to the destination (excluding
     * permissions, ACLs, etc.).  See documentation for 'rsync' for more info
     * on arguments.
     * 
     * NOTE: The rsyncbackup.js script already passed along the --exclude-from
     * argument if the 'excludes' configuration is specified above.
     */ 
    "rsyncAdditionalArguments": [
        "--archive",
        "--no-perms",
        "--no-acls",
        "--stats",
        "--delete",
        "--delete-excluded"
    ]
}`
}

/**
 * Variables that we just want accessible from anywhere
 */
const globals = {
    /**
     * Path of main working folder for rsyncbackup script
     */
    workingFolder: untildify(constants.WORKINGFOLDER),
    /**
     * Configuration settings for our script go here.
     */
    configFile: getBackupPath(constants.CONFIGFILE),
    /**
     * Excluded files and folders for rsync will be in this file.
     */
    excludesFile: getBackupPath(constants.EXCLUDESFILE),
    /**
     * Used for ensuring only one instance of the backup is running.
     */
    lockFile: getBackupPath(constants.LOCKFILE),
    /**
     * Created when a backup starts (mostly to figure out when our backup started)
     */
    startFile: getBackupPath(constants.STARTFILE),
    /**
     * If an error occured, this file will exist
     */
    errorFile: getBackupPath(constants.ERRORFILE),
    /**
     * If backup succeeded, this file will exist
     */
    successFile: getBackupPath(constants.SUCCESSFILE),
    /**
     * Arguments retrieved from commandline
     */
    args: {},
    /**
     * Configuration loaded from config.jsonc.  If not loaded or validation error
     * with configuration, then this value will be null.
     */
    configuration: null,
    /**
     * If configuration is null, this value is set to a message indicating why
     * the configuration was not loaded.
     */
    configurationError: '',
    /**
     * Status of the last completed backup.
     */
    backupStatus: BackupStatus.None,
    /**
     * Last date/time (formatted) of the last backup (regardless of outcome).
     * If null, that means we never started a backup before.
     */
    backupDate: null,
    /**
     * Number of minutes the backup has been running, or ran (depending on status)
     */
    backupDuration: 0,
}

/**
 * Bitbar items that we show as the main item (shows on menubar) for a given bitBar view
 */
const bitbarHeaders = {
    /**
     * Show when backup is running
     */
    backupRunning: {
        text: ':running:'
    },
    /**
     * Show when last backup ended in error
     */
    backupError: {
        text: ':rage:'
    },
    /**
     * Show if last backup ended in success
     */
    backupSuccess: {
        text: ':smile:'
    },
    /**
     * Show if there is no status for the backup (i.e. it hasn't run yet) */    
    backupNoStatus: {
        text: ':expressionless:'
    }
}

const bitbarItems = {
    configurationError: {
        text: 'Error in config: '
    }
}

const bitbarActions = {
    /**
     * Shows a "Configure..." option and brings up the config file in a text editor when selected.
     */
    configure: {
        text: 'Configure...',
        bash: 'open',
        param1: '-t',
        param2: globals.configFile,
        terminal: false
    },
    /**
     * Shows a "Start backup" option and manually starts backup process when selected.
     */
    startBackup: {
        text: 'Start backup',
        //bash: See init()
        param1: 'start',
        terminal: false
    },
    /**
     * Shows a "Stop backup" option and manually stops backup process if running, when selected.
     */
    stopBackup: {
        text: 'Stop backup',
        //bash: See init(),
        terminal: false
    }
}

/**
 * Do any initalization required for the script at startup
 */
async function init() {
    // Pull in commandline arguments
    globals.args = yargs
        .boolean(['start', 'stop'])
        .default('start', false)
        .default('stop', false)
        .describe('start', 'Starts the backup')
        .describe('stop', 'Stops the backup')
        .argv;

    // Create missing items as needed
    await createFolderIfNeeded(globals.workingFolder);
    createFileIfNeeded(globals.configFile, constants.DEFAULTCONFIG);
    createFileIfNeeded(globals.excludesFile, constants.DEFAULTEXCLUDES);

    // Load in configuration
    loadConfiguration();

    // Setup any bitbar items with additional info after init
    bitbarActions.startBackup.bash = globals.args['$0'];
    bitbarActions.stopBackup.bash = `${globals.args['$0']} stop`;
    bitbarItems.configurationError.text += globals.configurationError;

    // Get and store our lastest backup status
    getBackupStatus();
}

/**
 * Starts the backup process
 */
function startBackup() {
    console.log('START BACKUP!');
}

/**
 * Stops the backup process, if it's running
 */
function stopBackup() {
    console.log('STOP BACKUP!');
}

/**
 * Returns BitBar-friendly status of the backup.  This is the default when no
 * arguments are passed to the script.
 */
function defaultOutput() {
    // If lockfile exists, we're running
    if(global.backupStatus == BackupStatus.Running) {
        bitbar([
            bitbarHeaders.backupRunning,
            bitbar.separator,
            {
                text: `Running for ${global.backupDuration} minutes`,
            },
            bitbarActions.stopBackup
        ]);
    }
    // If error file exists, something is wrong
    else if(global.backupStatus == BackupStatus.Failed) {
        bitbar([
            bitbarHeaders.backupError,
            bitbar.separator,
            {
                text: `Backup failed!`
            },
            bitbarActions.configure
        ]);
    }
    // If success file exists, the last backup succeeded
    else if (global.backupStatus == BackupStatus.Succeeded) {
        const formattedFileDate = !globals.backupDate ? 'never' : formatDate(globals.backupDate);
        bitbar([
            bitbarHeaders.backupSuccess,
            bitbar.separator,
            {
                text: `Last backup ${formattedFileDate}`
            },
            bitbarActions.configure
        ]);

        if(!global.configuration) {
            bitbar([bitbarItems.configurationError]);
        }
        else {
            bitbar([bitBarActions.startBackup]);
        }
    }
    // Otherwise, something is amiss
    else {
        bitbar([
            bitbarHeaders.backupNoStatus,
            bitbar.separator,
            bitbarActions.configure
        ]);        

        if(!globals.configuration) {
            bitbar([bitbarItems.configurationError]);
        }
    }
}

/**
 * Create the folder if it doesn't exist
 * @param {*} folderPath 
 */
async function createFolderIfNeeded(folderPath) {
    if(!fs.existsSync(folderPath)) {
        await mkdirp(folderPath);
    }
}

/**
 * Creates the specified file with default content, if it doesn't exist.
 * @param {string} filePath 
 * @param {string} defaultContent 
 */
function createFileIfNeeded(filePath, defaultContent) {
    if(!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent);
    }
}

/**
 * Starts an instance of the backup if we are scheduled to do so
 */
function startBackupIfScheduled() {

}

/**
 * Retrieve and store information related to the last successful, failed or in-progress backup
 */
function getBackupStatus() {
    let now = new Date();
    // Only get modify date for startFile if the file exists
    if(fs.existsSync(globals.startFile)) {
        globals.backupDate = getFileDate(globals.startFile);
    }
    // If no start file exists, then should assume we never did a backup
    else {
        return;
    }

    // If a lockfile exists, then our backup is currently running
    if(fs.existsSync(globals.lockFile)) { 
        // Duration is start of backup to now
        let durationDateDiff = new DateDiff(now, backupDate);
        globals.backupStatus = BackupStatus.Running;
        globals.backupDuration = durationDateDiff.minutes();
    }
    // Else if error file exists, our last backup failed
    else if(fs.existsSync(globals.errorFile)) {
        // Duration is start of backup to date/time of error file
        let errorFileDate = getFileDate(globals.errorFile);
        let durationDateDiff = new DateDiff(errorFileDate, backupDate);
        globals.backupStatus = BackupStatus.Failed;
        globals.backupDuration = durationDateDiff.minutes();
    }
    // Else if success file exists, our last backup succeeded
    else if(fs.existsSync(globals.successFile)) {
        // Duration is start of backup to date/time of error file
        let successFileDate = getFileDate(globals.successFile);
        let durationDateDiff = new DateDiff(successFileDate, backupDate);
        globals.backupStatus = BackupStatus.Succeeded;
        globals.backupDuration = durationDateDiff.minutes();
    }

    // Else, we're in an unknown state (don't set any status)
}

/**
 * Loads and verifies 
 */
function loadConfiguration() {
    let content = fs.readFileSync(globals.configFile).toString();
    let configuration = {};
    try {
        configuration = jsonc.parse(content);
    } catch(e) {
        console.log('e = ', e);
        globals.configurationError = 'Error parsing configuration file';
        return;
    }
    console.log(configuration);
    
    // If rsync path is bad
    if(!configuration.rsyncPath || !fs.existsSync(configuration.rsyncPath)) {
        globals.configurationError = 'rsyncPath is invalid or file does not exist';
    }
    // If frequency isn't specified, or it's not a valid frequency
    else if(!configuration.frequency || !(configuration.frequency === 'manual' || getFrequencyInMinutes(configuration.frequency))) {
        globals.configurationError = 'frequency is invalid';
    }
    // Must have a valid source 
    else if(!configuration.source) {
        globals.configurationError = 'source must be set';
    }
    // Must have a valid destination
    else if(!configuration.destination) {
        globals.configurationError = 'destination must be set';
    }
    // Check whether our rsync arguments is a legit string array
    else if(!configuration.rsyncAdditionalArguments
        || !Array.isArray(configuration.rsyncAdditionalArguments)
        || !configuration.rsyncAdditionalArguments.reduce((prev, curr) => typeof prev === 'string' || typeof curr === 'string')) {
        console.log('rsyncAdditionalArguments = ', configuration.rsyncAdditionalArguments);
        console.log('rsyncAdditionalArguments.isArray = ', Array.isArray(configuration.rsyncAdditionalArguments));
        console.log('rsyncAdditionalArguments.reduce() = ', typeof configuration.rsyncAdditionalArguments[0]);
        globals.configurationError = 'rsyncAdditionalArguments is invalid'
    }

    // Config is good, let's save it as our actual config
    globals.configuration = configuration;
}

/**
 * Parses a frequency string into number of minutes
 * @param {string} frequency 
 */
function getFrequencyInMinutes(frequency) {
    let values = frequency.match(/^\s*(\d*)\s*([sSmMhHdD])\s*$/);
    // If frequency was in a valid format
    if(values) {
        let unit = values[2].toLowerCase();
        let value = values[1];
        switch(unit) {
            case 's':
                return value / 60;
                break;
            case 'm':
                return value;
                break;
            case 'h':
                return value * 60;
                break;
            case 'd':
                return value * 1440;
                break;
        }
    }

    return null;
}

/**
 * Gets the last time the specified file was modified.
 * @param {string} filePath 
 */
function getFileDate(filePath) {
    const { mtime } = fs.statSync(filePath);
    return birthtime;
}

/**
 * Formats specified to display as "M/D/YY h:mm AM/PM"
 * @param {Date} fileDate 
 */
function formatDate(fileDate) {
    const pattern = date.compile('M/D/YY h:mm A');
    return date.format(new Date(fileDate), pattern);
}

/**
 * Returns a full path and file using the configured backup path ()
 * @param {string} fileName 
 */
function getBackupPath(fileName) {
    return untildify(path.join(constants.WORKINGFOLDER, fileName));
}

// START HERE
(async () => {
    await init();

    if(globals.args.start) {
        startBackup();
    }
    else if(globals.args.stop) {
        stopBackup();
    }
    else {
        startBackupIfScheduled();
        defaultOutput();
    }
})();