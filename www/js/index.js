/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

// Wait for the deviceready event before using any of Cordova's device APIs.
// See https://cordova.apache.org/docs/en/latest/cordova/events/events.html#deviceready
document.addEventListener('deviceready', onDeviceReady, false);

// Variable globale pour MeetingManager
let meetingManager = null;

function onDeviceReady() {
    // Cordova is now initialized. Have fun!

    console.log('Running cordova-' + cordova.platformId + '@' + cordova.version);
    document.getElementById('deviceready').classList.add('ready');

    // Initialiser MeetingManager
    initializeMeetingManager();
}

/**
 * Initialise le MeetingManager et établit la connexion WebSocket
 */
function initializeMeetingManager() {
    try {
        console.log('[App] Initialisation de MeetingManager...');
        
        // Créer une instance de MeetingManager
        meetingManager = new MeetingManager();
        
        // Enregistrer des handlers pour les messages
        meetingManager.on('connection', (message) => {
            console.log('[App] Connexion établie:', message);
            updateConnectionStatus(true);
        });
        
        meetingManager.on('pong', (message) => {
            console.log('[App] Pong reçu:', message.timestamp);
        });
        
        meetingManager.on('ack', (message) => {
            console.log('[App] Accusé de réception:', message);
        });
        
        // Initialiser la connexion (adapter l'URL selon votre configuration)
        meetingManager.initialize('ws://192.168.1.189:8080')
            .then(() => {
                console.log('[App] MeetingManager initialisé avec succès');
                
                // Tester la connexion avec un ping après 1 seconde
                setTimeout(() => {
                    if (meetingManager.getConnectionStatus()) {
                        meetingManager.ping();
                    }
                }, 1000);
            })
            .catch((error) => {
                console.error('[App] Erreur initialisation MeetingManager:', error);
                updateConnectionStatus(false);
            });
            
    } catch (error) {
        console.error('[App] Erreur lors de l\'initialisation:', error.message);
    }
}

/**
 * Met à jour l'affichage du statut de connexion
 * @param {boolean} connected - État de connexion
 */
function updateConnectionStatus(connected) {
    const statusElement = document.getElementById('connection-status');
    if (!statusElement) {
        // Créer l'élément s'il n'existe pas
        const devicereadyDiv = document.getElementById('deviceready');
        if (devicereadyDiv) {
            const statusP = document.createElement('p');
            statusP.id = 'connection-status';
            statusP.className = 'event listening';
            statusP.textContent = connected ? 'WebSocket: Connecté' : 'WebSocket: Déconnecté';
            devicereadyDiv.appendChild(statusP);
        }
    } else {
        statusElement.textContent = connected ? 'WebSocket: Connecté' : 'WebSocket: Déconnecté';
        statusElement.className = connected ? 'event received' : 'event listening';
    }
}
