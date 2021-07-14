// ==============================================================
// confusion detection variables
let frameInterval,
    videoElement,
    collectElement,
    collectCtx; // to show face during the data collection

const total = 400;
let totalNeutral = total;
let totalConfused = total;
let collecting = 0;
let model_ver = 0;
let reporting = false;
const infer_interval = 1000; //ms
// ==============================================================
// constant definition (for better code comprehension)
// possible states of variable collecting
const NOTCOLLECTING = 0;
const CONFUSED = 1;
const NEUTRAL = 2;
// distinguish the type of data post to confusion(python) server
const COLLECTION = 0; // data collection state
const INFERENCE = 1; // server should predict confusion status
const INCREMENT = 2; // incremental data collection

// ==============================================================
videoElement = document.getElementById('input_video');
collectElement = document.getElementById('collect_canvas');
collectCtx = collectElement.getContext('2d');
// ==============================================================
document.getElementById("confused-btn").onclick = ()=>{
    disableButton('confused-btn');
    collecting = CONFUSED;
    setStage();
    collectionStart();
}
document.getElementById("neutral-btn").onclick = ()=>{
    disableButton('neutral-btn');
    collecting = NEUTRAL;
    setStage();
}
document.getElementById("prediction-btn").onclick = ()=>{
    setDescrition(`Predicting every ${infer_interval / 1000} second(s).`)
    let infer = setInterval(stateInference, infer_interval);

    document.getElementById("stop-btn").onclick = ()=>{
        clearInterval(infer);
        enableButton('prediction-btn');
        disableButton('stop-btn');
    };

    disableButton("prediction-btn");
    enableButton("stop-btn");
}

function collectionStart(){
    const camera = new Camera(videoElement, {
        onFrame: async () => {
            if (collecting !== NOTCOLLECTING) {
                // make sure data collection starts first
                await dataCollecting();
            } else if (totalConfused === 0 && totalNeutral === 0) {
                // Collection is done. Do nothing.
            }
        },
        width: 320,
        height: 180,
    });
    camera.start();
}

async function dataCollecting() {
    // on server side, label CONFUSED(1) is confused expressions, label NOTCOLLECTING(0) is neutral
    let label = collecting === CONFUSED ? CONFUSED : NOTCOLLECTING;
    let result = await reportState(COLLECTION, label)

    if (collecting === CONFUSED) { // collecting confusion
        totalConfused -= 1;
        setDescrition(totalConfused.toString() + ' confusion frames left...');
        if (totalConfused === 0) {
            collecting = NOTCOLLECTING;
            setStage();
            enableButton('neutral-btn');
        }
    } else { // collecting neutral
        totalNeutral -= 1;
        setDescrition(totalNeutral.toString() + ' neutral frames left...');
        if (totalNeutral === 0) {
            collecting = NOTCOLLECTING;
            setStage();
            enableButton("prediction-btn");
        }
    }
}

async function stateInference() {
    if (collecting === 0 && totalConfused === 0 && totalNeutral === 0) {
        let result = await reportState(INFERENCE, 0);
        setPrediction(result);
    }
}

async function reportState(stage, label) {
    // after data collection stage
    // if (stage === COLLECTION) {
    //     // During collection stage, collected data will be shown in modal dialogue.
    //     collectCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
    // } else if (reporting) {
    //     return null
    // }
    collectCtx.drawImage(videoElement, 0, 0, collectElement.width, collectElement.height);
    let base64ImageData = collectElement.toDataURL();
    let ver = 0;
    if (stage === INFERENCE) {
        ver = model_ver;
    } else if (stage === INCREMENT) {
        ver = ++model_ver;
    }
    let data = {
        img: base64ImageData,
        stage: stage,
        label: label,
        ver: ver,
        username: 1,
        frameId: label ? totalConfused : totalNeutral,
    };
    let result = null;
    try {
        if (stage === COLLECTION) {
            fetch('/detection', {
                method: 'POST',
                body: JSON.stringify(data),
                referrerPolicy: "origin",
            })
        } else {
            reporting = true;
            await fetch('/detection', {
                method: 'POST',
                body: JSON.stringify(data),
                referrerPolicy: "origin",
            }).then(
                response => response.json()
            ).then(data => {
                console.log(data)
                result = data.body.result;
            })
            reporting = false;
        }
    } catch (err) {
        console.error('ERROR:', err);
    }

    return result;
}

function setStage() {
    let stage = document.getElementById('stage');
    switch (collecting) {
        case NOTCOLLECTING:
            stage.innerText = 'Not collecting.';
            break;
        case CONFUSED:
            stage.innerText = 'Confused.';
            break;
        case NEUTRAL:
            stage.innerText = 'Neutral.';
            break;
        default:
            stage.innerText = 'Illegal value. Please check your code.';
    }
}

function setDescrition(msg) {
    let description = document.getElementById('description');
    description.innerText = msg;
}

function setPrediction(pred) {
    let prediction = document.getElementById('prediction');
    prediction.innerText = pred;
}

function enableButton(id) {
    let button = document.getElementById(id);
    button.disabled = false;
    button.classList.remove('btn-outline-primary');
    button.classList.add('btn-primary');
}

function disableButton(id) {
    let button = document.getElementById(id);
    button.disabled = true;
    button.classList.add('btn-outline-primary');
    button.classList.remove('btn-primary');
}