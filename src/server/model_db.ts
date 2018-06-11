/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as tf from '@tensorflow/tfjs';
import * as fs from 'fs';
import * as path from 'path';
import {promisify} from 'util';

const DEFAULT_MIN_UPDATES = 10;
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

function getLatestId(dir: string) {
  const files = fs.readdirSync(dir);
  return files.reduce((acc, val) => {
    if (val.endsWith('.json') && val.slice(0, -5) > acc) {
      return val.slice(0, -5);
    } else {
      return acc;
    }
  }, '0');
}

type TensorJSON = {
  values: number[],
  shape: number[],
  dtype?: tf.DataType
};

function dumpTensor(t: tf.Tensor) {
  return {
    'values': Array.from(t.dataSync()), 'shape': t.shape, 'dtype': t.dtype
  }
}

function loadTensor(obj: TensorJSON) {
  return tf.tensor(obj.values, obj.shape, obj.dtype || 'float32');
}

function generateNewId() {
  return new Date().getTime().toString();
}

async function readJSON(path: string) {
  const buffer = await readFile(path);
  return JSON.parse(buffer.toString());
}

export class ModelDB {
  dataDir: string;
  modelId: string;
  updating: boolean;
  minUpdates: number;

  constructor(dataDir: string, minUpdates?: number, currentModelId?: string) {
    this.dataDir = dataDir;
    this.modelId = currentModelId || getLatestId(dataDir);
    this.updating = false;
    this.minUpdates = minUpdates || DEFAULT_MIN_UPDATES;
  }

  async listUpdateFiles(): Promise<string[]> {
    const files = await readdir(path.join(this.dataDir, this.modelId));
    return files.map((f) => {
      return path.join(this.dataDir, this.modelId, f);
    });
  }

  async currentVars(): Promise<tf.Tensor[]> {
    const file = path.join(this.dataDir, this.modelId + '.json');
    const json = await readJSON(file);
    return json['vars'].map(loadTensor);
  }

  async possiblyUpdate() {
    const updateFiles = await this.listUpdateFiles();
    if (updateFiles.length < this.minUpdates || this.updating) {
      return;
    }
    this.updating = true;
    await this.update();
    this.updating = false;
  }

  async update() {
    const updatedVars = await this.currentVars();
    const updateFiles = await this.listUpdateFiles();
    const updatesJSON = await Promise.all(updateFiles.map(readJSON));

    // Compute total number of examples for normalization
    let totalNumExamples = 0;
    updatesJSON.forEach((obj) => {
      totalNumExamples += obj['numExamples'];
    });
    const n = tf.scalar(totalNumExamples);

    // Apply normalized updates
    updatesJSON.forEach((u) => {
      const nk = tf.scalar(u['numExamples']);
      const frac = nk.div(n);
      u['vars'].forEach((v: TensorJSON, i: number) => {
        const update = loadTensor(v).mul(frac);
        updatedVars[i] = updatedVars[i].add(update);
      });
    });

    // Save results and update key
    const newModelId = generateNewId();
    const newModelDir = path.join(this.dataDir, newModelId);
    const newModelPath = path.join(this.dataDir, newModelId + '.json');
    const newModelJSON = JSON.stringify({'vars': updatedVars.map(dumpTensor)});
    await writeFile(newModelPath, newModelJSON);
    await mkdir(newModelDir);
    this.modelId = newModelId;
  }
}