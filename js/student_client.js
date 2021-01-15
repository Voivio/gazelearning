// import { ZoomMtg } from '@zoomus/websdk';
// var ZoomMtg = require('@zoomus/websdk');
// ==============================================================
document.addEventListener("DOMContentLoaded", () => openModal("calibrateModal"));

window.onload = async function () {
    //////set callbacks for GazeCloudAPI/////////
    GazeCloudAPI.OnCalibrationComplete = function () {
        console.log('gaze Calibration Complete');
        calibrated = true;
        var pos = findAbsolutePosition(document.getElementById('container'));
        hm_left = pos.left;
        hm_top = pos.top;
        openModal('initModal');
    }
    GazeCloudAPI.OnCamDenied = function () { console.log('camera access denied') }
    GazeCloudAPI.OnError = function (msg) { console.log('err: ' + msg) }
    GazeCloudAPI.UseClickRecalibration = true;
    GazeCloudAPI.OnResult = PlotGaze;

    // 2021.1.4 instead of canvas, the visualization is moved to SVG.
    // let svgNode = document.createElement("svg");
    // svgNode.id = 'plotting_svg';
    // document.getElementById('container').appendChild(svgNode);

    // let containerRect = document.getElementById("container").getBoundingClientRect();
    // maxH = containerRect.height;
    // maxW = containerRect.width;
    // let svg = d3.select("#plotting_svg")
    //     .attr("width", maxW)
    //     .attr("height", maxH);

    let svg = d3.select("#plotting_svg");
    svg.on('click', (e)=>report(e))
        .style("left", 0)
        .style("top", 0)
        .style("width", 0)
        .style("height", 0);

    // ZoomMtg.setZoomJSLib('node_modules/@zoomus/websdk/dist/lib', '/av');
    // ZoomMtg.preLoadWasm();
    // ZoomMtg.prepareJssdk();

    // const zoomMeeting = document.getElementById("zmmtg-root");

    // ==============================================================
    // confusion detection initializations
    videoElement = document.getElementById('input_video');
    canvasElement = document.getElementById('output_canvas');
    canvasCtx = canvasElement.getContext('2d');
    collectElement = document.getElementById('collect_canvas');
    collectCtx = collectElement.getContext('2d');
    // ==============================================================

    userInfo = getCookie('userInfo');
    if (!userInfo) throw Error('No user information. Please log in.');
    userInfo = JSON.parse(userInfo);

    selectCamera();
}

// @string.Format("https://zoom.us/wc/{0}/join?prefer=0&un={1}", ViewBag.Id, System.Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("Name Test")))

// Sync Gaze Information
function systemStart(fastMode) {
    if (fastMode) {
        console.log('Fast mode is on. No data collection process.')
        totalConfused = 0;
        totalNeutral = 0;
    } else {
        collecting = CONFUSED; // start with collecting confused expressions
    }

    const camera = new Camera(videoElement, {
        onFrame: async () => {
            if (collecting !== NOTCOLLECTING) {
                await dataCollecting();
            } else if (totalConfused === 0 && totalNeutral === 0) {

            }
        },
        width: 320,
        height: 180,
        deviceId: cameraId,
    });
    camera.start();

    let infer = setInterval(() => {
        updateGazePoints()
        .catch(err => {
            clearInterval(infer);
            console.log(err)
        });
    }, inferInterval);
}

async function updateGazePoints() {
    // console.log(`identity ${identity}, studentNumber ${studentNumber}`) // debug line
    if (totalConfused !== 0 || totalNeutral !== 0) return;

    stateInference().then(()=>{
        if (secondCounter % updateInterval === 0) {
            console.log(`Second Counter ${secondCounter}`)
            update();
        }
    });
    // error will be handled by parent function, because its async, error are returned in Promise
}

async function update() {
    // decide what to post, then post using function signaling()
    let identity =  userInfo['identity']; //teacher(2) or student(1)
    let studentNumber = userInfo['number'];

    console.log('Updating student...');
    // query()
    // .then(() => {
    // // Random test part
    // // Math.random() returns a random number inclusive of 0, but not 1
    // // only choose last two built-in gaze traces since they have timestamp information
    // let randomGazeIndex = Math.floor(Math.random() * (GazeX.length - 2) ) + 2;
    // let beginTimestamp = Math.floor(Math.random() * timestamp[randomGazeIndex].length * 0.75);
    // let endTimestamp = beginTimestamp;
    // while (timestamp[randomGazeIndex][endTimestamp] - timestamp[randomGazeIndex][beginTimestamp] < updateInterval*1000) {
    //     endTimestamp++;
    // }
    // timestamp_win = timestamp[randomGazeIndex].slice(beginTimestamp, endTimestamp);
    // for (let i = 0; i < updateInterval; i++) {
    //     confusion_win[i] = Math.random() > 0.5 ? "Confused" : "Neutral";
    // }
    //
    // let samples = {
    //     x: GazeX[randomGazeIndex].slice(beginTimestamp, endTimestamp),
    //     y: GazeY[randomGazeIndex].slice(beginTimestamp, endTimestamp),
    //     t: timestamp[randomGazeIndex].slice(beginTimestamp, endTimestamp),
    // }
        let samples = {
            x: gazeX_win,
            y: gazeY_win,
            t: timestamp_win,
        }

        console.log(`Length of gaze ${gazeX_win.length}`);

        let [fixations, saccades] = detector.detect(samples);

        let any_confused = confusion_win.some((state) => state === 'Confused');

        if (any_confused && fixations.length !== 0) {
            let lastConfusedFixation = 0;

            for (const [i, state] of confusion_win.entries()) {
                if (state === 'Confused') {
                    let tConfusion = (i + 1)*inferInterval + timestamp_win[0];
                    for (let fixation of fixations) {
                        if (fixation.contain(tConfusion)) {
                            fixation.incConfusionCount()
                            lastConfusedFixation = fixations.indexOf(fixation);
                        } else if (fixation.start >= tConfusion) {
                            break;
                        }
                    }
                }
            }

            fixations.forEach((fixation, i) => {
                console.log(`#${i} : Confusion Count = ${fixation.confusionCount}`);
            })
            console.log(`Last fixation : #${lastConfusedFixation}`)

            if (fixations[lastConfusedFixation].confusionCount > 0) {
                console.log('draw box!')
                showPromptBox(fixations[lastConfusedFixation], patch_w, patch_h);
            } else {
                showPromptBox(fixations[lastConfusedFixation], -1, -1); // -1 means to delete
            }
        }

        gazeX_win = [];
        gazeY_win = [];
        timestamp_win = [];
        confusion_win = [];

        signaling(
            'sync',
            {
                stuNum: studentNumber,
                fixations: fixations,
                saccades: saccades,
            },
            identity
        );
    // });
}

async function signaling(endpoint, data, role) {
    // post... [ Dongyin: one day I will refactor this function to name post ]
    let headers = { 'Content-Type': 'application/json' },
        body = JSON.stringify({ ...data, role: role });

    let res = await fetch('/gazeData/' + endpoint,
        { method: 'POST', body, headers }
    );

    return res.json();
    // error will be handled by parent function, because its async, error are returned in Promise
}

// ==============================================================
// confusion detection functions
async function query() {
    let i;
    document.getElementById('plotting_svg').innerHTML = '';
    console.log(gaze_win);
    console.log(confusion_win);

    let all_same = true;
    for (i = 0; i < gaze_win.length - 1; ++i) {
        if (gaze_win[i].x !== gaze_win[i + 1].x || gaze_win[i].y !== gaze_win[i + 1].y) {
            all_same = false;
            console.log('here!!!false');
            break;
        }
    }

    // let all_confuse = confusion_win.every((state) => state === 'Confused');
    let any_confuse = confusion_win.some((state) => state === 'Confused');

    console.log(`all_same : ${all_same}, any_confuse : ${any_confuse}`);
    if (all_same && all_confuse && gaze_win.length > 0) {
        let x = gaze_win[0].x;
        let y = gaze_win[0].y;
        showPromptBox(x, y);
        console.log('draw box!!!');
    }
    gaze_win = [];
    confusion_win = [];

}

async function report(event) {
    document.getElementById('plotting_svg').innerHTML = '';

    console.log('You\'ve clicked on SVG! @'+new Date().getTime());

    // TODO: send data to server
    // signaling(
    //     'confusion',
    //     {
    //         state: 'confused',
    //         fixation: [0,0],
    //     },
    //     identity
    // );
}

function showPromptBox(fixation, minWidth, minHeight) {
    console.log('SHOW PROMPT BOX')

    let tFast = d3.transition()
        .duration(500);
    let tSlow = d3.transition()
        .duration(1000);

    let data = minWidth < 0 ? [] : [1]; // whatever the datum is, it is not important.
    let svg = d3.selectAll("#plotting_svg");

   svg.transition(tSlow)
    .style("left", fixation.xmin+'px')
    .style("top", fixation.ymin+'px')
    .style("width", minWidth < 0 ? 0+'px' : Math.max(minWidth, fixation.xmax - fixation.xmin)+'px')
    .style("height", minWidth < 0 ? 0+'px' : Math.max(minHeight, fixation.ymax - fixation.ymin)+'px');

    svg.selectAll('rect')
        .data(data)
        .join(
            enter => enter.append('rect')
                .attr('x', 0)
                .attr('y', 0)
                .attr('width', 0)
                .attr('height', 0)
                .attr('opacity', 0.7)
                .attr('fill', '#7584AD'),
            update => update,
            exit => exit.remove()
        ).transition(tFast)
        .attr('width', Math.max(minWidth, fixation.xmax - fixation.xmin))
        .attr('height', Math.max(minHeight, fixation.ymax - fixation.ymin));

    let text = svg.selectAll('text')
        .data(data)
        .join(
            enter => enter.append('text')
                .attr('x', 0)
                .attr('y', 0)
                .attr('stroke', 'black')
                .style("font-size", 14)
                .html("<tspan dx='5' dy='20'>Confused AROUND?</tspan><tspan x='5' dy='20'>Click to report.</tspan>"),
            update => update,
            exit => exit.remove()
        );
}

async function showCoords(event) {
    let cX = event.clientX;
    let cY = event.clientY;
    gazeX = cX;//GazeData.GazeX;
    gazeY = cY;//GazeData.GazeY;
    let gaze = document.getElementById("gaze");
    gaze.style.display = 'block'
    cX -= gaze.clientWidth / 2;
    cY -= gaze.clientHeight / 2;
    gaze.style.left = cX + "px";
    gaze.style.top = cY + "px";
    console.log('clicked!!!');
}

async function stateInference() {
    if (collecting === 0 && totalConfused === 0 && totalNeutral === 0) {
        let result = await reportState(INFERENCE, 0);
        document.getElementById('status_bar').innerHTML = 'Prediction result: ' + result;

        let containerHeight = document.getElementById('container').offsetHeight;
        let containerWidth = document.getElementById('container').offsetWidth;
        patch_h = containerHeight / grid_h;
        patch_w = containerWidth / grid_w;

        let x_ = Math.floor((gazeX - document.getElementById('container').offsetLeft) / patch_w);
        let y_ = Math.floor((gazeY - document.getElementById('container').offsetTop) / patch_h);
        // console.log(gazeX, gazeY, x_, y_);
        // gaze_win.push({ x: x_, y: y_ });
        confusion_win.push(result);

        secondCounter++;
    }

}

async function dataCollecting() {
    let label = collecting === CONFUSED ? CONFUSED : NOTCOLLECTING;
    let result = await reportState(COLLECTION, label)
    if (collecting === CONFUSED) { // collecting confusion
        totalConfused -= 1;
        document.getElementById('collectDescription').innerHTML = totalConfused.toString() + ' confusion frames left...';
        if (totalConfused === 0) {
            collecting = NOTCOLLECTING;

            document.getElementById("collectTitle").innerText = "Please make no expression.";
            document.getElementById("collectDescription").innerText = "Press \"Collect\" if you are ready.";
            document.getElementById("collectBtn").setAttribute("onclick", "collecting = NEUTRAL;");

            document.getElementById('confused_btn').disabled = false;
            document.getElementById('neutral_btn').disabled = false;
        }
    } else { // collecting neutral
        totalNeutral -= 1;
        document.getElementById('collectDescription').innerHTML = totalNeutral.toString() + ' neutral frames left...';
        if (totalNeutral === 0) {
            collecting = NOTCOLLECTING;

            closeModal("dataCollectModal");

            document.getElementById('confused_btn').disabled = false;
            document.getElementById('neutral_btn').disabled = false;
        }
    }
}

async function reportState(stage, label) {
    // after data collection stage
    if (stage === COLLECTION) {
        // During collection stage, collected data will be shown in modal dialogue.
        collectCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
    }
    canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
    let base64ImageData = canvasElement.toDataURL();
    let data = { img: base64ImageData, stage: stage, label: label, username: 'ruru' };
    let result = null;
    try {
        await fetch('http://127.0.0.1:8000', { // 172.20.16.10
            method: 'POST',
            body: JSON.stringify(data),
        }).then(
            response => response.json()
        ).then(data => {
            console.log(data)
            result = data.body.result;
        })
    } catch (err) {
        console.log('ERROR:', err);
    }

    return result;
}

async function reportNeutral() {
    if (collecting !== NOTCOLLECTING) {
        console.log('collecting data, quit');
    } else {
        if (totalNeutral === total) {
            collecting = NEUTRAL; // Neutral: 2
            document.getElementById('confused_btn').disabled = true;
            document.getElementById('neutral_btn').disabled = true;
            // console.log('already finished data collection, quit');
        } else if (totalNeutral === 0 && totalConfused === 0) {
            let result = await reportState(INCREMENT, 0); // stage: 2 (single report), neutral label: 0
            console.log(result)
            if (result === 'success') {
                console.log('data collected!');
            } else {
                console.log('data missed!', result);
            }
        } else {
            console.log('do nothing...');
        }
    }

}

async function reportConfusion() {
    if (collecting !== NOTCOLLECTING) {
        console.log('collecting data, quit');
    } else {
        if (totalConfused === total) {
            collecting = CONFUSED; // Confusion: 1
            document.getElementById('confused_btn').disabled = true;
            document.getElementById('neutral_btn').disabled = true;
            // console.log('already finished data collection, quit');
        } else if (totalNeutral === 0 && totalConfused === 0) {
            let result = await reportState(INCREMENT, 1); // stage: 2 (single report), confusion label: 1
            if (result === 'success') {
                console.log('data collected!');
            } else {
                console.log('data missed!', result);
            }
        } else {
            console.log('do nothing...');
        }
    }
}
// ==============================================================