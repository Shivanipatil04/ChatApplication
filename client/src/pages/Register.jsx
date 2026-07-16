import {useState} from 'react'
import axios from 'axios'
import {Link, useNavigate} from 'react-router-dom'

const Register = () => {

    const[user, setUser] = useState({
        name: "",
        email: "",
        password:""
    });
    const [error, setError] = useState('');
    const navigate = useNavigate();

    const handleSubmit = async (e) =>{
        e.preventDefault();
        try{
            await axios.post("http://localhost:5000/api/auth/register", user);
            navigate('/login');
        }
        catch(err){
            setError(err.response?.data?.message || 'Unable to create account. Please try again.');
        }

    }

    const handleChange = (e) =>{
        const{name, value} = e.target;
        setUser((prevUser)=>({
            ...prevUser,
            [name]: value
        })
    )}

  return (
    <div className="register">
        <h1>Register Yourself</h1>
        <form onSubmit={handleSubmit}>
            <input type="text" name="name" placeholder="Enter Name" value={user.name} onChange={handleChange}/>

            <input type="email" name="email" placeholder="Enter Email" value={user.email} onChange={handleChange}/>

            <input type="password" name="password" placeholder="Enter Password" value={user.password} onChange={handleChange}/>

            <button type="submit">Register</button>

            {error && <p className="auth-error">{error}</p>}
            <p>Already have an account? <Link to="/login">Login here</Link></p>
        </form>
    </div>
  )
}

export default Register
