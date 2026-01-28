import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY", // Replace with your actual keys from the console
  authDomain: "cavite-live-track.firebaseapp.com",
  databaseURL: "https://cavite-live-track-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "cavite-live-track",
  storageBucket: "cavite-live-track.firebasestorage.app",
  messagingSenderId: "195142604130",
  appId: "1:195142604130:web:82479738eed78aaf01c83b",
  measurementId: "G-XL267WFSFF"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);