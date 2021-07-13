const {FILEPATH, errorHandler, getLogger, readUsers} = require("./helpers");

let express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multipart = require("connect-multiparty");
const cookieParser = require('cookie-parser');
const {Resolver} = require('dns').promises;

const PORT = process.env.PORT || 5000;
const app = express();

// To process login form
const multipartyMiddleware = multipart();

// Logger initialization
const logger = getLogger('server');

// ===================================
// Registered student name and instructor passcode
const crypto = require("crypto");
let digestMessage = function (message) {
    return crypto.createHash("sha256").update(message.toString()).digest("hex")
};
let teacherPasscodeHash = digestMessage('cogteacher');
let studentAuthHash = digestMessage('student');
let teacherAuthHash = digestMessage('teacher');
// identity of user
const STUDENT = 1;
const TEACHER = 2;
// Read registered student name list
const studentsFilename = path.join(FILEPATH, 'registeredInfo', 'registeredStudents.json');
let studentsFileModifyTime;
const regInfoUpdateInterval = 30*60*1000;

let registeredStudents;
readUsers(studentsFilename).then((users) => {
    registeredStudents = users
}).catch((err) => logger.error(err));
let maintainUsers = setInterval(()=>{
    logger.info(`Updating students list. ${registeredStudents.size} students.`)
    const stats = fs.statSync(studentsFilename);
    if (stats.mtimeMs === studentsFileModifyTime) {
        // File not modified. Skip.
        logger.info("No change since last update.");
        return
    }
    // File has been modified
    studentsFileModifyTime = stats.mtimeMs;
    readUsers(studentsFilename).then((users) => {
        registeredStudents = users;
        logger.info(`Students name list updated. Now ${registeredStudents.size} students.`);
    }).catch((err) => logger.error(err));
}, regInfoUpdateInterval);

// ===================================
// Find dedicated service for instructor
const dedicated_service_hostname = 'dedicated-python-nodeport-service.default.svc.cluster.local';
let dedicated_service_address = undefined;
const resolver = new Resolver();
resolver.setServers(['10.52.0.10']); // Specify DNS server in the cluster.

resolver.resolve4(dedicated_service_hostname).then((addresses) => {
    logger.info(`address of ${dedicated_service_hostname}: ${JSON.stringify(addresses)}`);
    dedicated_service_address = addresses[0]
}).catch(e => logger.error(e));

// ===================================
// HTTP server
let server = http.Server(app);
server.listen(PORT, function () {
    logger.info(`gaze server running @ ${PORT}`);
});

// ===================================
// App settings
// app.use(cors())
let verifyStudent = verifyUser(STUDENT),
    verifyTeacher = verifyUser(TEACHER);
let ts = new Date();

app.use(express.static(path.join(__dirname, 'public')));

app.post('/users', multipartyMiddleware, newUserLogin);

app.get('/studentPage.html',
    cookieParser(),
    express.json({type: '*/*'}),
    verifyStudent,
    (req, res) => {
        res.statusCode = 200;
        res.sendFile(path.join(__dirname, 'restricted', 'studentPage.html'));
    });

app.get('/teacherPage.html',
    cookieParser(),
    express.json({type: '*/*'}),
    verifyTeacher,
    (req, res) => {
        res.statusCode = 200;
        res.sendFile(path.join(__dirname, 'restricted', 'teacherPage.html'));
    });

app.get('/summary.html',
    cookieParser(),
    express.json({type: '*/*'}),
    verifyTeacher,
    async (req, res) => {
        res.statusCode = 200;
        res.sendFile(path.join(__dirname, 'restricted', 'summary.html'));
    });

app.get('/studentInfo',
    cookieParser(),
    express.json({type: '*/*'}),
    verifyTeacher,
    allStudents);

app.get('/studentInfo/:stuNum',
    cookieParser(),
    express.json({type: '*/*'}),
    verifyTeacher,
    // async (req, res, next) => {
    //     await sleep(200);
    //     next()
    // },
    studentInfo)

app.post('/gazeData/cluster', express.json(), clusteringTest);

// Save and relay gaze data POSTed from students
app.post('/gazeData/sync',
    express.json({type: '*/*'}),
    saveGazePoints,
    sendGazePoints,
    receptionConfirm);

// Error handling
app.use(errorHandler);

function newUserLogin(req, res, next) {
    // Creates user directory and generate cookie
    let content = req.body;
    logger.debug('============================')
    logger.debug(content);
    const identity = +content.identity;

    if (identity === STUDENT) {
        // Check if the name is valid. All name will be converted to lower case at client side.
        if (!registeredStudents.has(content.name)) {
            let err = new Error('Student name not registered.');
            err.statusCode = 401;
            return next(err);
        }
        // Update ts if day has changed
        const loginTimestamp = new Date();
        if (loginTimestamp.getDay() !== ts.getDay()) ts = loginTimestamp;
        // Make new directory day by day
        const studentNumber = registeredStudents.get(content.name).toString();
        const infoDatePath = path.join(FILEPATH, studentNumber, 'info');
        if (!fs.existsSync(infoDatePath)) {
            fs.mkdir(infoDatePath,
                {recursive: true},
                (err) => {
                    if (err) throw err;
                });
        }
    } else {
        // Teacher
        // Check if correct passcode is provided.
        if (content.passcodeHash !== teacherPasscodeHash) {
            let err = new Error('Wrong teacher passcode. Please retry.');
            err.statusCode = 401;
            return next(err);
        }
    }

    res.cookie(
        'userInfo',
        JSON.stringify({
            'identity': content.identity,
            'name': content.name,
            'number': identity === STUDENT ? registeredStudents.get(content.name) : null,
            'authcode': identity === STUDENT ? studentAuthHash : teacherAuthHash,
        })
    );

    res.send({message: 'Cookie set.'});
}

function verifyUser(identity) {
    return function (req, res, next) {
        if (!req.cookies['userInfo']) { // Cookie is not set.
            let err = new Error('Please login first.');
            err.statusCode = 401;
            return next(err);
        } else { // Hash of passcode does not pass.
            let parsedCookie = JSON.parse(req.cookies['userInfo']);
            const authHash = identity === STUDENT ? studentAuthHash : teacherAuthHash;
            if (parsedCookie.authcode !== authHash) {
                let err = new Error(`${identity === STUDENT ? 'Student' : 'Instructor'} authentication code mismatch.`);
                err.statusCode = 401;
                return next(err);
            }
        }
        // Authorization code match. Allow to proceed.
        next();
    }
}

function saveGazePoints(req, res, next) {
    // Save gaze data and cog data from student
    let filename = `${ts.getFullYear()}-${ts.getMonth() + 1}-${ts.getDate()}`;

    const writableStream = fs.createWriteStream(
        path.join(FILEPATH,
            `${req.body['stuNum']}`,
            'info',
            `${filename}.json`
        ), {flags: 'a'});
    // ',' (comma) is the delimiter
    writableStream.write(JSON.stringify(req.body) + '|');

    // req is a ended stream.Readable. readable.readableEnded=true;
    next();
}

function sendGazePoints(req, res, next) {
    // Send gaze data to instructor
    const endpoint = 'http://' + dedicated_service_address + '/gazeData/teacher';

    const req_instructor = http.request(endpoint,
        {
            method: 'POST',
            headers: req.headers,
        },
        (res) => {
            logger.info(`STATUS: ${res.statusCode}`);
            // logger.info(`HEADERS: ${JSON.stringify(res.headers)}`);
            // res.setEncoding('utf8');
            // res.on('data', (chunk) => {
            //     logger.info(`BODY: ${chunk}`);
            // });
            // res.on('end', () => {
            //     logger.info('No more data in response.');
            // });
        }
    )

    req_instructor.on('error', (e) => {
        logger.error(`problem with request: ${e.message}`);
    });

    // Write data to request body
    req_instructor.write(JSON.stringify(req.body));
    req_instructor.end();

    next()
}

async function receptionConfirm(req, res) {
    // let { , role, pts } = req.body;
    let role = +req.body['role'];
    logger.info('==========================');
    logger.info(`Received POST from ${role === 1 ? 'student' : 'teacher'}`);

    try {
        // we have students posting gaze information
        let stuNum = req.body['stuNum'];
        logger.info(`Student number : ${stuNum}`);

        res.statusCode = 200;
        res.send({
            result: `Fixations and saccades are logged @ ${Date.now()}`,
        });
    } catch (e) {
        logger.error(e.message);
        res.send({error: e.message});
    }
}

function allStudents(req, res) {
    // The filename is simple the local directory and tacks on the requested url
    let filename = `${ts.getFullYear()}-${ts.getMonth() + 1}-${ts.getDate()}`;
    // Check if student has related info
    let stuNums = [];
    for (let stuNum of registeredStudents.keys()) {
        if (fs.existsSync(path.join(FILEPATH,
            `${req.params['stuNum']}`,
            'info',
            `${filename}.json`
        ))) stuNums.push(stuNum);
    }

    res.statusCode = 200;
    res.send(JSON.stringify(stuNums));
}

function studentInfo(req, res) {
    // The filename is simple the local directory and tacks on the requested url
    let filename = `${ts.getFullYear()}-${ts.getMonth() + 1}-${ts.getDate()}`;
    // This line opens the file as a readable stream
    const readStream = fs.createReadStream(path.join(FILEPATH,
        `${req.params['stuNum']}`,
        'info',
        `${filename}.json`
    ));
    // const readStream = fs.createReadStream(path.join(FILEPATH, `${req.params['stuNum']}`, 'info', '2021-4-24.json'));
    // This will wait until we know the readable stream is actually valid before piping
    readStream.on('open', function () {
        // This just pipes the read stream to the response object (which goes to the client)
        readStream.pipe(res);
    });
    // This catches any errors that happen while creating the readable stream (usually invalid names)
    readStream.on('error', function(err) {
        res.end(err);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ===================================
// Some code about spectral clustering
// Now moved to python dedicated server.
// ===================================

const kmeans = require('ml-kmeans');
const {Matrix, EigenvalueDecomposition} = require('ml-matrix');

function clusteringTest(req, res, next) {
    // Exist because fixationTest.html is using this endpoint
    let fixations = req.body;
    logger.info(`Receive ${fixations.length} fixations at ${new Date()}`);

    let fixationX = fixations.map(fixation => [fixation.x_per]);
    let fixationY = fixations.map(fixation => [fixation.y_per]);

    res.format({
        'application/json': function () {
            res.send({result: JSON.stringify(spectralCluster(fixationX, fixationY, 5))});
        }
    });

    res.send();
}

function spectralCluster(X, Y, repeat) {
    logger.debug(`inside spectral cluster, X : ${X.length}, Y : ${Y.length}, repeat : ${repeat}`)

    let matX = X instanceof Matrix ? X : new Matrix(X);
    let matY = Y instanceof Matrix ? Y : new Matrix(Y);

    // Construct similarity matrix
    let sigma = 2.5;
    let distance = matX.repeat({columns: matX.rows})
        .subtract(matX.transpose().repeat({rows: matX.rows}))
        .pow(2)
        .add(
            matY.repeat({columns: matY.rows})
                .subtract(matY.transpose().repeat({rows: matY.rows}))
                .pow(2)
        ).sqrt().div(-2 * sigma * sigma).exp();
    let D = Matrix.diag(
        distance.mmul(Matrix.ones(distance.rows, 1)).to1DArray().map(item => 1 / item)
    );

    // Eigenvalue decomposition
    let eig = new EigenvalueDecomposition(Matrix.eye(distance.rows).sub(D.mmul(distance)));
    let lambda = eig.realEigenvalues.sort(); // js array
    let deltaLambda = lambda.slice(0, lambda.length - 1)
        .map((elem, i) => lambda[i + 1] - elem);
    let k = deltaLambda.slice(0, Math.ceil(lambda.length / 2))
        .reduce((maxIdx, item, index) => deltaLambda[maxIdx] < item ? index : maxIdx, 0) + 1;
    // var k = Math.random() > 0.5 ? 4 : 3;
    logger.debug(`k = ${k}`);

    let columns = [];
    for (let i = 0; i < k; i += 1) {
        columns.push(i);
    } // it surprises me that JS has no native function to generate a range...
    let data = eig.eigenvectorMatrix.subMatrixColumn(columns).to2DArray(); // Dimension reduced

    // K-means, run repeat times for stable clustering
    let trails = []
    for (let i = 0; i < repeat; i += 1) {
        trails.push(reorder(kmeans(data, k).clusters, k));
    }
    return mode(trails, k);
}

function reorder(cluster, k) {
    let prev = 0;
    let nClass = 1;
    let order = [cluster[prev]];

    while (nClass <= k) {
        if (cluster[prev] !== cluster[prev + 1] && order.indexOf(cluster[prev + 1]) === -1) {
            nClass += 1;
            order.push(cluster[prev + 1]);
        }
        prev += 1;
    }

    return cluster.map(elem => order.indexOf(elem));
}

function mode(nestedArray, max) {
    let depth = nestedArray.length;
    let arrLen = nestedArray[0].length;
    let mode = [];

    for (let i = 0; i < arrLen; i += 1) {
        let elemCount = Matrix.zeros(1, max).to1DArray();
        for (let j = 0; j < depth; j += 1) {
            elemCount[nestedArray[j][i]] += 1;
        }
        mode.push(elemCount.indexOf(Math.max(...elemCount)));
    }

    logger.debug(mode);
    return mode
}

// ===================================
// Some code about HTTPS server
// Now it is not required, because k8s ingress is handling HTTPS oart.
// ===================================
// const https = require('https');
// let httpsServer;
// let sslCrt = 'cert.pem';
// let sslKey = 'privkey.pem';
// async function startServer() {
//     logger.info('starting express');
//     try {
//         const tls = {
//             cert: fs.readFileSync(sslCrt),
//             key: fs.readFileSync(sslKey),
//         };
//         httpsServer = https.createServer(tls, app);
//         httpsServer.on('error', (e) => {
//             logger.error('https server error,', e.message);
//         });
//         await new Promise((resolve) => {
//             httpsServer.listen(PORT, () => {
//                 logger.info(`server is running and listening on ` +
//                     `https://localhost:${PORT}`);
//                 resolve();
//             });
//         });
//     } catch (e) {
//         if (e.code === 'ENOENT') {
//             logger.error('no certificates found (check config.js)');
//             logger.error('  could not start https server ... trying http');
//         } else {
//             err('could not start https server', e);
//         }
//         app.listen(PORT, () => {
//             logger.info(`http server listening on port ${PORT}`);
//         });
//     }
// }
//
// startServer()

// ===================================
// Some code about Zoom
// ===================================
// var sdk_key = "Mp3WNg7cR5Se5eseb20xX2sRBk4eARKfrsCP";
// var sdk_secret = "Ovbr5wsX7kmgN23dTEn19vSY7fg0Juenl86S";
// var session_ID = "2530883354";
// var session_pwd = "";

// function generateInstantToken(sdkKey, sdkSecret, topic, password = "") {
//     let signature = "";
//     // try {
//     const iat = Math.round(new Date().getTime() / 1000);
//     const exp = iat + 60 * 60 * 2;

//     // Header
//     const oHeader = { alg: "HS256", typ: "JWT" };
//     // Payload
//     const oPayload = {
//         app_key: sdkKey,
//         iat,
//         exp,
//         tpc: topic,
//         pwd: password,
//     };
//     // Sign JWT
//     const sHeader = JSON.stringify(oHeader);
//     const sPayload = JSON.stringify(oPayload);
//     signature = KJUR.jws.JWS.sign("HS256", sHeader, sPayload, sdkSecret);
//     return signature;
// }

// generateInstantToken(
//     sdk_key,
//     sdk_secret,
//     session_ID,
//     session_pwd
// ); // call the generateInstantToken function

// ===================================
// Some code about confusion detection
// Now moved to python server
// ===================================
// var svmpkg = require('machinelearn/svm')
// const { OneClassSVM } = svmpkg;
// const svm = new OneClassSVM();
// let dataset = [];
// let confusion_queue = [];
// app.post('/gazeData/svm', express.json({ type: '*/*' }), async (req, res) => {
//     let {grid} = req.body;
//     dataset.push(grid);
//     res.send(Math.floor(Math.random() * 10));
//
//     // svm.loadASM().then((loadedSVM) => {
//     //     var clf_res = loadedSVM.predict([grid]);
//     //     res.send({ result: clf_res });
//     //     if (dataset.length < 50)
//     //         loadedSVM.fit(dataset, new Array(dataset.length).fill(0));
//     // });
//
// });
//
// app.post('/gazeData/confusion', express.json({ type: '*/*' }), async (req, res) => {
//     let { state, fixation } = req.body;
//     confusion_queue.push(state);
//
//     // svm.loadASM().then((loadedSVM) => {
//     //     var clf_res = loadedSVM.predict([grid]);
//     //     res.send({ result: clf_res });
//     //     if (dataset.length < 50)
//     //         loadedSVM.fit(dataset, new Array(dataset.length).fill(0));
//     // });
//
// });
