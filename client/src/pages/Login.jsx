import {useState} from 'react'
import axios from 'axios'
import {Link, useNavigate} from 'react-router-dom'

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    try {
      const { data } = await axios.post('http://localhost:5000/api/auth/login', { email, password });
      localStorage.setItem('chatToken', data.token);
      localStorage.setItem('chatUser', JSON.stringify(data.user));
      navigate('/chat');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to log in. Please try again.');
    }
  };
  return (
    <div className="login">
        <h1>Login</h1>
        <form onSubmit ={handleLogin}>
            <input type = "email" placeholder = "Enter Email" value = {email} onChange = {(e) => setEmail(e.target.value)}/>

            <input type = "password" placeholder = "Enter Password" value = {password} onChange = {(e) => setPassword(e.target.value)}/>

            <button type="submit">Login</button>
            {error && <p className="auth-error">{error}</p>}
            <p>Don't have an account? <Link to="/register">Register here</Link></p>
        </form>
    </div>
  )
}

export default Login
