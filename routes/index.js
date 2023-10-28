var express = require('express');
var router = express.Router();
var path = require('path');
var mysql = require('mysql2');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const process = require('process');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');
const calendar = google.calendar('v3');
require('dotenv').config()

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// Setup: MySQL connection
var connection = mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    dateStrings: true
});

// Setup: Gmail authentication for Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_AUTH_USER,
        pass: process.env.GMAIL_AUTH_PASSWORD
    }
});

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

/**
 * Serializes credentials to a file compatible with GoogleAUth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
}

/**
 * Show home page
 * 
 */
router.get('/', function (req, res, next) {
    res.render('index');
    console.log("get home page");
});

/**
 * Show filter_result page
 * 
 */
router.post('/filter_result', function (req, res, next) {
    if (req.body.gender == 'other') {
        res.render('reject');
    }
    else {
        // Ask the database if the new participant is qualified
        var q;
        if (req.body.score < 5) {
            q = `SELECT * FROM participants 
            WHERE gender = '${req.body.gender}' and score < 5;`
        }
        else {
            q = `SELECT * FROM participants 
            WHERE gender = '${req.body.gender}' and score >= 5;`
        }

        connection.query(q, function (error, results, fields) {
            if (error) throw error;

            var qualified = (results.length < 5);
            if (qualified) {
                res.render('calendar', {
                    gender: req.body.gender,
                    age: req.body.age,
                    score: req.body.score,
                    email: req.body.email,
                    res: JSON.stringify(results, null, 4)
                });
            }
            else {
                res.render('reject');
            }
        });
    }

});


/**
 * Handle HTTP request (fetch) from client-side JavaScript
 * 
 */
router.get('/api/:date', function (req, res, next) {

    var q = `SELECT * FROM participants
    WHERE meeting_time LIKE '${req.params.date}%'`;
    // 1. The percent sign is SQL syntax, meaning any number of any characters
    // 2. The backtick is JavaScript syntax, used for multi-line string
    // 3. The dolloar sign and curly brackets are JavaScript syntax, used for inserting variables

    connection.query(q, function (error, results, fields) {
        if (error) throw error;
        res.send(results);
    });
});

/**
 * Show complete page
 * 
 */
router.post('/complete', function (req, res, next) {

    var q = `INSERT INTO participants(gender, age, score, email, meeting_time)
    VALUES('${req.body.gender}', '${req.body.age}', ${req.body.score}, '${req.body.email}', '${req.body['date-time']}' );`

    // Insert data into database
    connection.query(q, function (error, results, fields) {
        if (error) {
            // throw error;
            console.log("Error at database query: " + error);
            res.render('complete', { res: JSON.stringify(results, null, 4), error: error });
        }
        else {
            // Google API authorization
            authorize()
                .then(function (auth) {
                    // Create an event before generating a Google Meet link
                    const user_datetime = new Date(req.body['date-time']);
                    console.log(auth);
                    const event = {
                        'summary': '聊天機器人安安',
                        'start': {
                            'dateTime': user_datetime.toISOString()
                        },
                        'end': {
                            'dateTime': user_datetime.toISOString()
                        },
                        conferenceData: {
                            createRequest: {
                                conferenceSolutionKey: {
                                    type: 'hangoutsMeet'
                                },
                                requestId: 'i-have-no-idea'
                                // Not sure how the value affects the google meet link
                            }
                        }
                    };

                    calendar.events.insert({
                        auth: auth,
                        calendarId: 'primary',
                        resource: event,
                        conferenceDataVersion: 1
                    }, function (error2, event) {
                        if (error2) {
                            console.log("Error during creating Google calendar event: " + error2);
                            res.render('complete', { res: JSON.stringify(results, null, 4), error: error2 });
                        }
                        else {
                            // Now the meeting link is available
                            // Set up email content
                            const mailOptions = {
                                from: 'penguinandy0902@gmail.com',
                                to: req.body.email,
                                subject: '【聊天機器人安安】實驗說明',
                                attachments: [{ path: './研究說明書.pdf' }, { path: './病毒.txt' }],
                                html: `
                                <p>參與者您好：</p>
                                <br />
                                <p>很高興您願意浪費時間參與我們的實驗。根據您填寫的資料，最後為您安排的實驗資訊如下：</p>
                                <br />
                                <p>實驗時間：${req.body['date-time']}</p>
                                <p>Google Meet：${event.data.hangoutLink}</p>
                                <br />
                                <p>您不用真的準時參加，因為我們也不會。只是想給您看看我們的系統能自動產生這些資訊，厲害吧。</p>
                                <p>附件包含了研究說明書，以及病毒檔。您並不需要在詳細閱讀研究說明書之後簽名，好讓我們卸責實驗的潛在風險，因為我們連實驗都不想做。另外，病毒檔請務必打開。</p>
                                `
                            };

                            // Send the mail
                            transporter.sendMail(mailOptions, function (error3, info) {
                                if (error3) {
                                    res.render('complete', { res: JSON.stringify(results, null, 4), error: error3 });
                                    console.log("Email not sent: " + error3);
                                } else {
                                    res.render('complete', { res: JSON.stringify(results, null, 4), error: '' });
                                    console.log('Email sent: ' + info.response);
                                }
                            });
                        }

                    })
                })
        }

    });

});

module.exports = router;
