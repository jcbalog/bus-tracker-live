import { auth, db } from './firebase-config.js';
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, doc, getDoc } from "firebase/firestore"; 
import L from 'leaflet';

let map;
let busMarkers = {};
let routeData = {};

async function init() {
    try {
        const response = await fetch('./routes.json');
        const data = await response.json();
        routeData = data.routes;
        initMap();
        
        onAuthStateChanged(auth, (user) => {
             if (!user) signInAnonymously(auth).catch(console.error);
             subscribeToBuses();
        });

    } catch (e) {
        console.error("Passenger Init Error:", e);
    }
}

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([14.39, 120.90], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
    }).addTo(map);

    if(routeData) {
        Object.values(routeData).forEach(r => {
            L.polyline(r.path, { color: r.color, opacity: 0.3, weight: 3 }).addTo(map);
        });
    }
}

function subscribeToBuses() {
    const busCollection = collection(db, 'artifacts', 'metro-cavite-v4', 'public', 'active_buses');
    onSnapshot(busCollection, (snapshot) => {
        const buses = [];
        snapshot.forEach(doc => buses.push(doc.data()));
        updateMap(buses);
        updateSidebar(buses);
    });
}

function updateMap(buses) {
    Object.keys(busMarkers).forEach(key => {
        if (!buses.find(b => b.driverId === key)) {
            map.removeLayer(busMarkers[key]);
            delete busMarkers[key];
        }
    });

    buses.forEach(b => {
        if (b.lat === 0) return;

        let color = '#fff'; 
        if (b.status === 'arriving') color = '#facc15';
        if (b.status === 'arrived') color = '#22c55e';
        if (b.status === 'departing') color = '#f97316';
        if (b.status === 'departed') color = '#ef4444';

        const isFast = b.speed > 60;
        const html = `
            <div class="bus-icon-wrapper ${isFast ? 'overspeeding-marker' : ''}">
                <div style="background:${color}; box-shadow: 0 0 10px ${color};" class="w-3 h-3 rounded-full border border-white"></div>
            </div>`;
        
        const icon = L.divIcon({ className: 'bg-transparent', html: html, iconSize: [20, 20] });

        if (!busMarkers[b.driverId]) {
            const marker = L.marker([b.lat, b.lng], { icon }).addTo(map);
            marker.bindPopup(`
                <div class="font-mono text-xs p-1">
                    <div class="font-bold text-sm">${b.driverName}</div>
                    <div class="text-gray-400 text-[10px]">${b.company}</div>
                    <div class="mt-1">Speed: ${Math.round(b.speed)} km/h</div>
                    <div style="color:${color}" class="font-bold uppercase">${b.status || 'Active'}</div>
                </div>
            `);
            busMarkers[b.driverId] = marker;
        } else {
            const marker = busMarkers[b.driverId];
            marker.setLatLng([b.lat, b.lng]);
            marker.setIcon(icon);
        }
    });
}

function updateSidebar(buses) {
    const list = document.getElementById('bus-list');
    if (!list) return;
    
    if (buses.length === 0) {
        list.innerHTML = '<div class="text-center py-10 text-gray-500 text-xs font-mono">NO ACTIVE BUSES</div>';
        return;
    }

    list.innerHTML = buses.map(b => `
        <div class="p-3 hover:bg-slate-800/50 cursor-pointer transition" onclick="window.focusBus('${b.driverId}')">
            <div class="flex justify-between items-center">
                <div>
                    <div class="font-bold text-xs">${b.driverName}</div>
                    <div class="text-[9px] text-gray-500 uppercase">${b.company}</div>
                </div>
                <div class="text-right">
                    <div class="font-mono font-bold text-cyan-400 text-xs">${Math.round(b.speed)} KM/H</div>
                    <div class="text-[9px] text-gray-400 uppercase">${b.status || 'On Route'}</div>
                </div>
            </div>
        </div>
    `).join('');
}

window.focusBus = (id) => {
    if (busMarkers[id]) {
        map.setView(busMarkers[id].getLatLng(), 15);
        busMarkers[id].openPopup();
    }
};

window.onload = init;