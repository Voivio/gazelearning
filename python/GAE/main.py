import json
import base64
import numpy as np
import cv2
import os
import mediapipe as mp
import math
from sklearn.svm import OneClassSVM
from sklearn import svm
from joblib import dump, load
from sklearn.decomposition import PCA
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
from sklearn.model_selection import GridSearchCV
from sklearn.svm import SVC
from sklearn.linear_model import SGDClassifier
import time
import argparse
import flask
from flask import Flask, redirect, render_template, request
from threading import Thread
import logging
from datetime import date
import re
import shutil

CNTR = 0
TOTAL = 400

# deployed = False

FILEPATH = '/mnt/fileserver'
# FILEPATH = '/mnt/d/mnt/fileserver' # Test using wsl
# FILEPATH = 'fileserver'

POI4AOI = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159,
           158, 157, 173, 263, 249, 390, 373, 374, 380, 381, 382, 362,
           466, 388, 387, 386, 385, 384, 398, 46, 53, 52, 65, 55, 70, 63, 105,
           66, 107, 276, 283, 282, 295, 285, 300, 293, 334, 296, 336]

if not os.path.exists(FILEPATH):
    # os.rmdir(FILEPATH)
    os.makedirs(FILEPATH)
    print('folder {} not find, have created one.'.format(FILEPATH))

modelPool = {}
metricPool = {}

def _normalized_to_pixel_coordinates(normalized_x, normalized_y, image_width, image_height):
    """Converts normalized value pair to pixel coordinates."""

    # Checks if the float value is between 0 and 1.
    def is_valid_normalized_value(value: float) -> bool:
        return (value > 0 or math.isclose(0, value)) and (value < 1 or
                                                          math.isclose(1, value))

    if not (is_valid_normalized_value(normalized_x) and
            is_valid_normalized_value(normalized_y)):
        # TODO: Draw coordinates even if it's outside of the image bounds.
        return None
    x_px = min(math.floor(normalized_x * image_width), image_width - 1)
    y_px = min(math.floor(normalized_y * image_height), image_height - 1)
    return x_px, y_px

def getCrop(img, landmarks):
    h, w, _ = img.shape
    pt1, pt2, pt3 = landmarks.landmark[133], landmarks.landmark[362], landmarks.landmark[2]
    matrix = warpFrom(
        _normalized_to_pixel_coordinates(pt1.x, pt1.y, w, h),
        _normalized_to_pixel_coordinates(pt2.x, pt2.y, w, h),
        _normalized_to_pixel_coordinates(pt3.x, pt3.y, w, h),
    )
    dstImg = cv2.warpAffine(img, matrix, (img.shape[1], img.shape[0]))

    left, top, bottom, right = -1, -1, -1, -1

    init = False
    for idx in POI4AOI:
        px = landmarks.landmark[idx]
        try:
            px = _normalized_to_pixel_coordinates(px.x, px.y, w, h)
            px = (matrix @ np.array([px[0], px[1], 1])).astype(np.int)
            if not init:
                left, right = px[0], px[0]
                top, bottom = px[1], px[1]
                init = True
                continue
            if left > px[0]:
                left = px[0]
            if right < px[0]:
                right = px[0]
            if top > px[1]:
                top = px[1]
            if bottom < px[1]:
                bottom = px[1]
        except Exception as e:
            print('ERROR:{}'.format(e))

    # return cv2.rectangle(dstImg, (left, top), (right, bottom), (255, 0, 0), 2)
    return dstImg[top:bottom+1, left:right+1]

def warpFrom(pt1, pt2, pt3):

    srcTri = np.array([[pt1[0], pt1[1]],
                       [pt2[0], pt2[1]],
                       [pt3[0], pt3[1]]]).astype(np.float32)

    dstTri = np.array([[300, 180],
                       [340, 180],
                       [320, 240]]).astype(np.float32)
    matrix = cv2.getAffineTransform(srcTri, dstTri)
    return matrix


class Metric:
    def __init__(self):
        self.req_count = 0
        self.file_count = 0
        self.nc_req_first = 0
        self.nc_req_last = 0
        self.nc_file_first = 0
        self.nc_file_last = 0
        self.c_req_first = 0
        self.c_req_last = 0
        self.c_file_first = 0
        self.c_file_last = 0

    def inc_req(self):
        self.req_count += 1

    def inc_file(self):
        self.file_count += 1

    def output(self):
        text = 'REQ COUNT : {}, FILE COUNT : {}\n'.format(
            self.req_count, self.file_count)
        text = text + 'NC PHASE: Req last {}, first {}, diff {}, File last {}, first {}, diff {}\n'.format(
            self.nc_req_last, self.nc_req_first, self.nc_req_last - self.nc_req_first / 60,
            self.nc_file_last, self.nc_file_first, self.nc_file_last - self.nc_file_first
        )
        text = text + 'C PHASE: Req last {}, first {}, diff {}, File last {}, first {}, diff {}\n'.format(
            self.c_req_last, self.c_req_first, self.c_req_last - self.c_req_first,
            self.c_file_last, self.c_file_first, self.c_file_last - self.c_file_first
        )
        return text

class StatePredictor:

    def __init__(self, usrname, logger):
        global FILEPATH
        self.facemesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1,
            min_detection_confidence=0.5)
        self.inputs = []
        self.labels = []
        self.clf = None
        self.pca = None
        self.username = usrname
        self.retrain_interval = 200 # TODO: incremental training!
        self.dir = os.path.join(FILEPATH, str(self.username), 'face')
        self.trained = False
        self.model_ver = 0
        # Same logger as gunicorn
        self.logger = logger
        # currently we make sure old images and models are removed before each lecture
        if not os.path.exists(self.dir):
            os.makedirs(self.dir)
        else:
            modelfiles = [f for f in os.listdir(self.dir) if '.joblib' in f]
            # find pca:
            pca_suspects = [f for f in modelfiles if re.search(
                "^pca.\d+.joblib", f) is not None]
            # find model_pca:
            model_suspects = [f for f in modelfiles if re.search(
                "^model_pca.\d+.joblib", f) is not None]

            if len(pca_suspects) == 1 and len(model_suspects) == 1:
                pca_path = pca_suspects[0]
                model_path = model_suspects[0]
                self.clf = load(os.path.join(self.dir, model_path))
                self.pca = load(os.path.join(self.dir, pca_path))
                self.model_ver = int(pca_path.split('.')[1])
                self.trained = True
    
    def model_reset(self):
        shutil.rmtree(self.dir)
        os.makedirs(self.dir)
        self.trained = False
        self.model_ver = 0
        self.pca = None
        self.clf = None

    def incre_train(self, img, label, ver):
        old_model_path = 'model_pca.{}.joblib'.format(ver - 1)
        old_pca_path = 'pca.{}.joblib'.format(ver - 1)
        if not self.trained:
            # load latest model
            # if the model is up-to-date, ver should be exactly model_ver + 1,
            # otherwise, we should load latest model (ver - 1) before incremental training.
            # Also remove old models before updating to new ones.
            if not os.path.exists(os.path.join(self.dir, old_model_path)) or \
                not os.path.exists(os.path.join(self.dir, old_pca_path)):
                return
            self.trained = True

        if ver > self.model_ver + 1 or self.clf is None:
            self.clf = load(os.path.join(self.dir, old_model_path))
            self.pca = load(os.path.join(self.dir, old_pca_path))
            
        os.remove(os.path.join(self.dir, old_model_path))
        os.remove(os.path.join(self.dir, old_pca_path))

        # train one step
        gt_input = np.reshape(img, (1,-1))
        gt_input = self.pca.transform(gt_input)
        gt_label = np.array([str(label)])
        self.clf = self.clf.partial_fit(gt_input, gt_label)

        self.logger.info('model updated: {} -> {}'.format(self.model_ver, ver))

        self.model_ver = ver

        dump(self.clf, os.path.join(
            self.dir, 'model_pca.{}.joblib'.format(self.model_ver)))
        dump(self.pca, os.path.join(self.dir, 'pca.{}.joblib'.format(self.model_ver)))


    def addData(self, img, label, frameId, incre=False, ver=0):
        global TOTAL, metricPool
        # if self.trained and not incre:
        #     self.logger.info('Ignore...')
        # Save collected image.
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img.flags.writeable = False
        results = self.facemesh.process(img)
        img.flags.writeable = True
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        if results.multi_face_landmarks:
            face_landmarks = results.multi_face_landmarks[0]
            # self.logger.debug(matrix)
            cropped = getCrop(img, face_landmarks)
            img = cv2.cvtColor(cv2.resize(
                cropped, (100, 50)), cv2.COLOR_BGR2GRAY)
            if not incre:
                cv2.imwrite(os.path.join(
                    self.dir, '{}_{}.jpg'.format(label, frameId)
                ), img)
            else:
                self.incre_train(img, label, ver)


        metricPool[self.username].inc_file()
        if frameId == TOTAL:
            # Receive first frame
            if label == 0:
                metricPool[self.username].nc_file_first = time.time()
            else:
                metricPool[self.username].c_file_first = time.time()

        if frameId == 1:
            # Receive last frame
            if label == 0:
                metricPool[self.username].nc_file_last = time.time()
            else:
                metricPool[self.username].c_file_last = time.time()
        
    
    def train(self):
        inputs = []
        labels = []
        img_list = [f for f in os.listdir(self.dir) if '.jpg' in f]
        for f in img_list:
            label, _ = f.split('_')
            img = cv2.imread(os.path.join(self.dir, f), cv2.IMREAD_GRAYSCALE)
            inputs.append(np.reshape(img, (-1)))
            labels.append(label)

        inputs = np.array(inputs)
        labels = np.array(labels)

        t0 = time.time()
        n_component = 150
        self.pca = PCA(n_component, svd_solver='auto',
                whiten=True).fit(inputs)
        self.logger.info('PCA fit done in {}s'.format(time.time() - t0))

        t0 = time.time()
        X_train_pca = self.pca.transform(inputs)
        self.logger.info('PCA transform done in {}s'.format(
            time.time() - t0))

        t0 = time.time()
        # self.clf = SVC()
        self.clf = SGDClassifier()
        self.logger.debug(X_train_pca.shape)
        self.clf = self.clf.fit(X_train_pca, labels)
        self.logger.info('SGDClassifier train done in {}s'.format(time.time() - t0))

        dump(self.clf, os.path.join(self.dir, 'model_pca.0.joblib'))
        dump(self.pca, os.path.join(self.dir, 'pca.0.joblib'))

        self.trained = True
    
    def threaded_train(self):
        Thread(target=self.train(), args=(self, )).start()
        self.logger.info('Threaded Training Started!!!')
        return 

    def confusionDetection(self, img, ver):
        model_path = 'model_pca.{}.joblib'.format(ver)
        pca_path = 'pca.{}.joblib'.format(ver)
        if not self.trained:
            # return 'training'
            if not os.path.exists(os.path.join(self.dir, model_path)) or not \
                os.path.exists(os.path.join(self.dir, pca_path)):
                return 'training'
            self.trained = True

        if self.clf is None or self.model_ver != ver:
            self.clf = load(os.path.join(self.dir, model_path))
            self.pca = load(os.path.join(self.dir, pca_path))
            self.model_ver = ver

        tag = ['Neutral', 'Confused']
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img.flags.writeable = False
        results = self.facemesh.process(img)
        img.flags.writeable = True
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        if results.multi_face_landmarks:
            face_landmarks = results.multi_face_landmarks[0]
            # self.logger.debug(matrix)
            cropped = getCrop(img, face_landmarks)
            img = cv2.cvtColor(cv2.resize(
                cropped, (100, 50)), cv2.COLOR_BGR2GRAY)
            feature = np.reshape(img, (1, -1))
            reduced_feature = self.pca.transform(feature)
            pred = self.clf.predict(reduced_feature)
            self.logger.debug(pred)
            res = tag[int(pred[0])]
            return res
        return 'N/A'


app = Flask(__name__)


@app.route('/', methods=['GET'])
def index():
    """ 
        The home page has a list of prior translations and a form to
        ask for a new translation.
    """

    return "<h1>GazeLearning Server: There's nothing you can find here!</h1>"


@app.route('/detection', methods=['POST'])
def confusion_detection():
    global CNTR, TOTAL, FILEPATH
    data = request.data #.decode('utf-8')
    data = json.loads(data)
    # app.logger.debug(data)
    img_bytes = base64.b64decode(data['img'].split(',')[1])
    im_arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(im_arr, flags=cv2.IMREAD_COLOR)
    stage = data['stage']
    username = data['username']
    ver = data['ver']
    if username not in modelPool:
        metricPool[username] = Metric()
        modelPool[username] = StatePredictor(username, app.logger)

    result = 'success'
    
    try:
        if stage == 0:
            app.logger.info('{}, stage {}, {}:No.{}'.
                format(username,
                    stage,
                    'Confusion' if data['label'] else 'Neutral',
                    TOTAL + 1 - data['frameId']
            ))
            metricPool[username].inc_req()
            modelPool[username].addData(img, data['label'], data['frameId'])
            app.logger.info('after add data')
            if data['frameId'] == TOTAL:
                # Recieve first frame
                if data['label'] == 0:
                    metricPool[username].nc_req_first = time.time()
                else:
                    modelPool[username].model_reset()
                    metricPool[username].c_req_first = time.time()
            elif data['frameId'] == 1:
                # Recieve last frame
                if data['label'] == 0:
                    metricPool[username].nc_req_last = time.time()
                    # here train the classifier at the last frame of NC collecting stage
                    modelPool[username].threaded_train()
                else:
                    metricPool[username].c_req_last = time.time()
        elif stage == 1:
            result = modelPool[username].confusionDetection(img, ver)
        else:
            modelPool[username].addData(
                img, data['label'], data['frameId'], incre=True, ver=ver)
    except Exception as e:
        result = 'ERROR'
        app.logger.error(e)
    resp = flask.Response()
    resp.set_data(json.dumps({'body': {'result': result}}))
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "x-api-key,Content-Type"
    resp.headers['Content-Type'] = 'application/json'
    return resp

if __name__ == '__main__':
    # This part of code will NOT be executed since we are using gunicorn.

    # parser = argparse.ArgumentParser()
    # parser.add_argument("-p", "--portid", type=int, default=0,
    #                     help="port id")
    # args = parser.parse_args()

    # PORT = 8000 + args.portid
    PORT = 8000
    # This is used when running locally only. When deploying to Google App
    # Engine, a webserver process such as Gunicorn will serve the app. This
    # can be configured by adding an `entrypoint` to app.yaml.
    # Flask's development server will automatically serve static files in
    # the "static" directory. See:
    # http://flask.pocoo.org/docs/1.0/quickstart/#static-files. Once deployed,
    # App Engine itself will serve those files as configured in app.yaml.
    app.run(host='0.0.0.0', port=PORT, debug=True, threaded=True, static_files={
        '/demo': os.path.join(os.path.dirname(__file__), 'demo')
    })
else:
    # use same log handlers as in gunicorn logger
    gunicorn_logger = logging.getLogger('gunicorn.error')
    app.logger.handlers = gunicorn_logger.handlers
    app.logger.setLevel(gunicorn_logger.level)
