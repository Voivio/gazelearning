// import { OneClassSVM } from '../node_modules/machinelearn/svm';
var mouseX = 0;
var mouseY = 0;
var gazeList = [];
var clearCmd = false;
var wg_started = false;
var gaze_grid = []
var grid_w = 13,
    grid_h = 8;
var patch_w = 0,
    patch_h = 0;

var confused = false;

window.onload = async function () {
    // document.getElementById('container').onmousemove = function (event) {
    //     mouseX = event.clientX;
    //     mouseY = event.clientY;
    //     console.log(mouseX, mouseY);
    //     let gaze = document.getElementById('gaze');
    //     let docx = mouseX - gaze.clientWidth / 2;
    //     let docy = mouseY ;//- gaze.clientHeight / 2;

    //     gaze.style.left = docx + "px";
    //     gaze.style.top = docy + "px";
    // }
    // setInterval(async () => {
    //     addGaze().catch(err => {
    //         clearInterval(addGaze);
    //         console.log(err)
    //     });
    // }, 250);

    gaze_grid = new Array(grid_h * grid_w).fill(0);
    patch_h = document.getElementById('video').offsetHeight / grid_h;
    patch_w = document.getElementById('video').offsetWidth / grid_w;


    // WebGazer
    webgazer.params.showVideoPreview = true;
    //start the webgazer tracker
    await webgazer.setRegression('ridge') /* currently must set regression and tracker */
        //.setTracker('clmtrackr')
        .setGazeListener(function (data, clock) {
            //   console.log(data); /* data is an object containing an x and y key which are the x and y prediction coordinates (no bounds limiting) */
            //   console.log(clock); /* elapsed time in milliseconds since webgazer.begin() was called */
            if (data == null) {
                return;
            }
            var xprediction = data.x; //these x coordinates are relative to the viewport
            var yprediction = data.y; //these y coordinates are relative to the viewport

            var loc_x = Math.floor((xprediction - document.getElementById('video').offsetLeft) / patch_w);
            var loc_y = Math.floor((yprediction - document.getElementById('video').offsetTop) / patch_h);

            if (loc_x >= 0 && loc_x <= grid_w && 
                loc_y >= 0 && loc_y <= grid_h) {
                    gaze_grid[loc_y * grid_w + loc_x] += 1;
                }
            
            var gaze = document.getElementById("gaze");
            xprediction -= gaze.clientWidth / 2;
            yprediction -= gaze.clientHeight / 2;

            gaze.style.left = xprediction + "px";
            gaze.style.top = yprediction + "px";

            // if (clearCmd) gazeList = [];
            // else gazeList.push({xprediction, yprediction});

            // console.log(xprediction, yprediction);
            // console.log(elapsedTime);
        });
    // webgazer.showPredictionPoints(true); /* shows a square every 100 milliseconds where current prediction is */
    hideVideoElements();
    setInterval(async () => {
        analyzeGaze().catch(err => {
            clearInterval(analyzeGaze);
            console.log(err)
        });
    }, 5000);
}

function hideVideoElements() {
    webgazer.showPredictionPoints(false);
    webgazer.showVideo(false);
    webgazer.showFaceOverlay(false);
    webgazer.showFaceFeedbackBox(false);
    //webgazer.showGazeDot(false);
};

async function report(event) {
    if (event.key == 'c') {
        document.getElementById('state_bar').innerHTML = 'confusion reported!';
        document.getElementById('detection_result').innerHTML = 'detection result: ';
        confused = true;
    }
    
}

async function analyzeGaze() {
    if (confused) {
        confused = false;
        let { result } = await signaling('svm', { grid: gaze_grid });
        document.getElementById('state_bar').innerHTML = '';
        // var result = Math.floor(Math.random()*10);
        // if (result >= 5)
        //     document.getElementById('detection_result').innerHTML = 'detection result: confused';
        // else
        //     document.getElementById('detection_result').innerHTML = 'detection result: not confused';
        // console.log(result);
        console.log(gaze_grid);
        gaze_grid = new Array(grid_h * grid_w).fill(0);
    }
}

async function beginWG() {
    if (!wg_started) {
        await webgazer.begin();
        wg_started = true;
        document.getElementById("gaze").style.display = 'block';
    }
}

async function endWG() {
    if (wg_started) {
        await webgazer.end();
        // closeWebGazer();
        wg_started = false;
    }
}

async function signaling(endpoint, data) {
    // post...
    let headers = { 'Content-Type': 'application/json' },
        body = JSON.stringify({ ...data, role: 'Test' });

    let res = await fetch('/gazeData/' + endpoint,
        { method: 'POST', body, headers }
    );

    return res.json();
    // error will be handled by parent function, because its async, error are returned in Promise
}