import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css'; // Optional: Global styles
import App from './App';

// Create a root for rendering the app
const root = ReactDOM.createRoot(document.getElementById('root'));

// Render the App component inside React Strict Mode
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);