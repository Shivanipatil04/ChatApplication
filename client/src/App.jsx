import React from 'react'
import {BrowserRouter, Routes, Route} from 'react-router-dom'
import ChatApp from './pages/ChatApp'

const App = () => {
  return (
    <BrowserRouter>
      <div>
        <Routes>
          <Route path="/" element={<ChatApp/>} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App