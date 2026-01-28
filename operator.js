import { auth, db } from './firebase-config.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, onSnapshot } from "firebase/firestore";

const appId = 'metro-cavite-v4';
const domain = "@metrocavite.com";

let currentUser = null;

async function init() {
    const response = await fetch('./routes.json');
    const data = await response.json();
    const select = document.getElementById('reg-company');
    data.companies.forEach(c => select.innerHTML += `<option value="${c}">${c}</option>`);

    onAuthStateChanged(auth, user => {
        if (user) checkProfile(user);
        else showAuth();
    });

    setupListeners();
}

function setupListeners() {
    document.getElementById('tab-login').addEventListener('click', () => {
        document.getElementById('login-form').classList.remove('hidden');
        document.getElementById('signup-form').classList.add('hidden');
    });
    document.getElementById('tab-signup').addEventListener('click', () => {
        document.getElementById('login-form').classList.add('hidden');
        document.getElementById('signup-form').classList.remove('hidden');
    });

    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('signup-form').addEventListener('submit', handleSignup);
    document.getElementById('btn-logout').addEventListener('click', () => signOut(auth));
}

async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
    try {
        await signInWithEmailAndPassword(auth, user + domain, pass);
    } catch (err) {
        alert("Login Failed: " + err.message);
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const user = document.getElementById('reg-user').value;
    const pass = document.getElementById('reg-pass').value;
    const company = document.getElementById('reg-company').value;
    
    try {
        const cred = await createUserWithEmailAndPassword(auth, user + domain, pass);
        await setDoc(doc(db, 'artifacts', appId, 'public', 'operators', cred.user.uid), {
            username: user,
            company: company,
            role: 'operator'
        });
        alert("Operator Account Created!");
    } catch (err) {
        alert("Signup Failed: " + err.message);
    }
}

async function checkProfile(user) {
    const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'operators', user.uid));
    if (snap.exists()) {
        currentUser = { uid: user.uid, ...snap.data() };
        showDashboard();
    } else {
        alert("No operator profile found.");
        signOut(auth);
    }
}

function showAuth() {
    document.getElementById('auth-section').classList.remove('hidden');
    document.getElementById('dashboard-section').classList.add('hidden');
}

function showDashboard() {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('dashboard-section').classList.remove('hidden');
    document.getElementById('op-company').innerText = currentUser.company;

    const qReq = query(collection(db, 'artifacts', appId, 'public', 'drivers'), 
        where('company', '==', currentUser.company), 
        where('status', '==', 'pending'));
    
    onSnapshot(qReq, snap => {
        const list = document.getElementById('requests-list');
        list.innerHTML = '';
        if (snap.empty) list.innerHTML = '<div class="text-center text-gray-600 text-xs py-4">NO PENDING REQUESTS</div>';
        snap.forEach(d => {
            const data = d.data();
            list.innerHTML += `
                <div class="bg-slate-800 p-2 rounded flex justify-between items-center border border-gray-700">
                    <div class="text-xs">
                        <div class="font-bold text-white">${data.name}</div>
                        <div class="text-gray-500">${data.username}</div>
                    </div>
                    <div class="flex gap-1">
                        <button onclick="window.approve('${d.id}')" class="px-2 py-1 bg-green-600 rounded text-[10px] text-white">ACCEPT</button>
                        <button onclick="window.reject('${d.id}')" class="px-2 py-1 bg-red-600 rounded text-[10px] text-white">REJECT</button>
                    </div>
                </div>`;
        });
    });

    const qLogs = query(collection(db, 'artifacts', appId, 'public', 'shift_logs'), where('company', '==', currentUser.company));
    onSnapshot(qLogs, snap => {
        const list = document.getElementById('logs-list');
        list.innerHTML = '';
        snap.forEach(d => {
            const data = d.data();
            const color = data.type === 'START' ? 'text-green-400' : 'text-red-400';
            list.innerHTML += `
                <div class="p-2 border-b border-gray-800 flex justify-between text-xs">
                    <span class="text-gray-300">${data.driverName}</span>
                    <span class="${color} font-bold">${data.type}</span>
                </div>`;
        });
    });
}

window.approve = async (id) => await updateDoc(doc(db, 'artifacts', appId, 'public', 'drivers', id), { status: 'approved' });
window.reject = async (id) => await deleteDoc(doc(db, 'artifacts', appId, 'public', 'drivers', id));

window.onload = init;